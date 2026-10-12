# WeChat Mac — Decrypt, Export & MCP Server

Scripts to extract SQLCipher keys from WeChat's process memory, export chat history,
and run a **read-only** MCP server for live chat queries.

## Files

| File | Purpose |
|------|---------|
| `extract_key.py` | Extracts encryption keys from WeChat memory (requires sudo) |
| `export_messages.py` | Batch export all messages/contacts to JSON + Markdown |
| `mcp_server.py` | MCP server — live chat queries, contact search, voice transcription (read-only) |
| `wechat_ocr.py` + `wxvision.swift` | Reads WeChat from the screen with Apple Vision OCR. No keys, no re-sign. The working path on WeChat 4.1.15 |
| `test_wechat_ocr.py` | Unit tests for the OCR parsers (synthetic lines): `python3 -m unittest test_wechat_ocr -v` |

## Reading WeChat by screenshot + OCR (works on 4.1.15, no keys)

The key-extraction steps below no longer work on WeChat 4.1.15 / macOS 27. The OCR reader replaces them
for "what is happening in WeChat lately".

```bash
python3 wechat_ocr.py            # capture now, print chat list + open chat, save under ~/.wechat-export/ocr/
python3 wechat_ocr.py --json     # same, as JSON
```

- It captures the main WeChat window (`screencapture -l`, so WeChat can sit behind other windows or on
  another display), runs Vision OCR (Chinese + English), and parses the chat list (name, last time,
  last-message preview, unread count) and the transcript of the chat that is open.
- Needs Screen Recording permission for the app that launches it (VS Code, Terminal). The Swift helper
  compiles itself on first run (`~/.wechat-export/bin/wxvision`).
- Output: `~/.wechat-export/ocr/` (`latest.md`, `latest.json`, `chats/<chat>.md`, `activity.jsonl`). Created
  `0700`, outside git.
- MCP tools: `wechat_screen_snapshot` (capture now) and `wechat_screen_history` (what changed, last N days).
  `wechat_query_chat`, `wechat_search_messages` and `wechat_recent_activity` fall back to the same data
  when no database keys exist.
- `wechat_screen_snapshot` and `--stitch` never click, so they never mark a chat as read. A background click
  (`postToPid`) on the chat list was tried on 2026-10-11 and WeChat ignored it; real input is only used by
  `--auto-read` below, which needs a quiet Mac.
- Limits: OCR is approximate. Group names are cut by WeChat itself, emoji are lost, stickers and images show
  as `[non-text message]`, and each chat shows only its last preview unless it is the open chat. To get a
  chat's recent messages, leave that chat open in WeChat before the capture. History only covers moments a
  capture ran (every MCP call and every `/life` scan).
- Several days of one chat: open it in WeChat, then run `python3 wechat_ocr.py --stitch 90 --chat <name>` and
  scroll up slowly (about half a screen every 2 s). It captures every ~2 s, merges overlapping screens into
  one transcript and saves it under `chats/`. Scrolling faster than one screen per capture leaves a gap
  (reported as `skipped` frames). Only the open chat is captured, and nothing is scrolled for you: if you
  do not scroll during the run, the transcript stays at the one visible screen.
- Hands-free reading of several chats: `python3 wechat_ocr.py --auto-read [--top 5 | --chats A,B] [--days 3]
  [--idle 120] [--wait MINUTES]` (MCP tool `wechat_screen_read`). It uses real clicks and scroll-wheel events,
  so it needs Accessibility permission for the launching app, and it only runs after `--idle` seconds
  without keyboard or mouse input. It stops as soon as a key is pressed or the pointer moves, then puts the
  pointer and the frontmost app back. Chats are taken from the visible chat list (first N, skipping File
  Transfer, Subscriptions and similar), opened by clicking the row, and scrolled back until a time stamp
  older than `--days` shows. The scroll direction is learned on the first chat. Limits: opening a chat marks
  it read, on the phone too; emoji-heavy names come out garbled in the list, so the chat that actually
  opened is read and saved under its own header title; the Mac must not be locked or asleep.
  `wxvision click/scroll` refuse unless a WeChat window is the topmost window at that point.
  Scroll size is calibrated (a wheel step of d moves the pane about d+50 pt; it starts at 30% of the pane and
  adapts). A screen that does not move (same text positions) means the top of the chat; a screen of only
  images keeps scrolling. The chat list is re-read before every click because it reorders on new messages, and
  with `--chats` the opened title must match the name or the chat is skipped (the row is found again and clicked
  once more before giving up). A chat-list title that Vision drops (a time with no name beside it, seen with a
  short name plus emoji) is re-read from a thin crop. `--trace` prints every screen read
  to stderr (it contains chat text).
- Saved transcripts (`chats/<chat>.md` and `.json`) keep real dates ("2026-10-10 08:08"), not "Yesterday", and a
  later capture is merged into the saved one when the screens overlap. A capture that shares no message with the
  saved one replaces it and the old file moves to `chats/_previous/`. A chat whose title OCRs a little differently
  each time (an emoji read as "い", "®", "。") still lands in the same file: `same_chat_title` treats names as one
  chat when one is a prefix of the other with at most 2 extra characters ("(N)" unread counts are ignored).
- Parser rules worth knowing: text starting right of x=420 pt is an outgoing bubble (`me`); in a 1:1 chat
  (title without a `(N)` member count) text left of x=321 pt is image content and is ignored; the window
  is usually 2x Retina, so all layout constants are in points and scaled by `ocr_width / window_width`.

## When to Run

- After a fresh WeChat install or major update (code signature resets)
- When you want a fresh export of all chat history
- Keys change on WeChat restart, so re-extract if the saved keys stop working

## Quick Refresh (one-shot script)

For routine refreshes after a WeChat update, use the wrapper script — it runs all 5 steps below in order, prompting for sudo and the QR-code login:

```bash
~/code/brain/scripts/refresh-wechat.sh
```

Then in VS Code: `Cmd+Shift+P` → `MCP: Restart Server` → wechat.

The manual steps below are for first-time setup or debugging.

## Prerequisites

```bash
brew install sqlcipher    # SQLCipher 4.x CLI
pip3 install pycryptodome # Only if using HMAC verification (optional)
```

## Steps

### 1. Re-sign WeChat (one-time per install/update)

Quit WeChat first, then strip the hardened runtime so we can read process memory:

```bash
sudo codesign --force --deep --sign - /Applications/WeChat.app
```

This replaces Apple's signature with an ad-hoc one. WeChat still works normally — it just loses Gatekeeper trust and hardened runtime protection. Auto-update or reinstall will revert it.

### 2. Launch WeChat & Login

Open WeChat and scan the QR code from your phone. Wait until you're fully logged in and can see chats.

### 3. Extract Keys

```bash
sudo python3 extract_key.py
```

Output: `/tmp/wechat_keys.json` (all DB keys) and `/tmp/wechat_key.txt` (primary key).

Verify manually:

```bash
KEY=$(cat /tmp/wechat_key.txt)
DB=~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/*/db_storage/message/message_0.db
/opt/homebrew/bin/sqlcipher $DB \
  "PRAGMA key = \"x'$KEY'\"; PRAGMA cipher_compatibility = 4; PRAGMA cipher_page_size = 4096; SELECT count(*) FROM sqlite_master;"
# Should output a number > 0
```

### 4. Export Messages

```bash
python3 export_messages.py
```

Output goes to `~/.wechat-export/` (gitignored):
- `chats/*.md` — Markdown per contact/group
- `contacts.json` — 8,700+ contacts
- `all_messages.json` — full message dump
- `summary.json` — metadata

### 5. Save Keys

```bash
cp /tmp/wechat_keys.json ~/.wechat-export/.keys.json
cp /tmp/wechat_key.txt ~/.wechat-export/.primary_key.txt
```

## How It Works

1. **WCDB** (Tencent's SQLCipher wrapper) caches the derived encryption key in process memory as `x'<64hex_key><32hex_salt>'`
2. The extract script uses macOS Mach VM API (`task_for_pid` → `mach_vm_region` → `mach_vm_read_overwrite`) to scan all readable memory regions
3. It matches the salt from each DB file's first 16 bytes against hex patterns found in memory
4. HMAC verification confirms the key is correct before saving
5. Each DB may have a different key — the script extracts all of them

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `task_for_pid failed (kr=5)` | WeChat needs re-signing: `sudo codesign --force --deep --sign - /Applications/WeChat.app` then restart WeChat |
| `WeChat is not running` | Launch WeChat and login first |
| Keys don't work after restart | Re-run `extract_key.py` — WCDB regenerates keys on restart |
| WeChat won't launch after re-sign, or "Data Access Blocked" popup (macOS 27) | Restore: `ditto <backup>/WeChat.app.orig /Applications/WeChat.app`, or reinstall from wechat.com |
| `Operation not permitted` | Run with `sudo` |

## Known Issue: WeChat 4.1+ Key Extraction (since ~June 2026)

WeChat 4.1+ changed how WCDB handles the derived key in memory. Re-signing
still gets `task_for_pid` working, but the static memory scan (`extract_key.py`,
including the salt-anchor fallback added for 4.1+) has been finding 0/N verified
keys on the last few attempts. Current status lives in the `STATUS` docstring at
the top of `mcp_server.py` — check there before assuming this is fixed.

**Community alternatives evaluated (2026-07-07)**, in response to a WeChat-decrypt
roundup that surfaced three new repos targeting WeChat 4.1.x:

| Repo | Technique | Verdict |
|------|-----------|---------|
| [Thearas/wechat-db-decrypt-macos](https://github.com/Thearas/wechat-db-decrypt-macos) (627★, **archived**) | `lldb`-based memory scan (`find_key_memscan.py`), not raw Mach VM API | Different technique from ours — plausible it still works where ours doesn't, since lldb gets broader memory access. **Requires disabling SIP** (`csrutil disable`). Untested against 4.1.11.23 (they tested 4.1.2.241). Archived = no upstream fixes if it breaks again. |
| [xingfanxia/wechat-mac-reader](https://github.com/xingfanxia/wechat-mac-reader) (7★) | Wrapper: Thearas' extractor + `chatlog-bot` (Go HTTP/MCP server) + a separate Accessibility-API "send" MCP | Just glues Thearas' extraction to a different serving layer. Adopting the whole stack is unnecessary — our own `mcp_server.py`/`export_messages.py` already consume the same `wechat_keys.json` shape. If Thearas' extractor works, point it at our tooling instead of theirs. |
| [lawchito0813-sketch/wechat-export-macos-x86](https://github.com/lawchito0813-sketch/wechat-export-macos-x86) (6★) | AI-assisted export | Explicitly doesn't support the current WeChat version. Skip. |

**Tested 2026-07-07 — Thearas' `lldb` approach does NOT solve this either.**
Cloned it to `~/code/playground/_watchlist/wechat-db-decrypt-macos` and ran
`find_key_memscan.py` against our already ad-hoc-re-signed WeChat (hardened
runtime already stripped by `refresh-wechat.sh` step 2):

- **lldb attached fine without disabling SIP.** Their documented "SIP must be
  disabled" prerequisite is a non-issue once the target app is already
  ad-hoc re-signed — SIP was never actually the blocker. Don't bother
  disabling SIP for this; it wouldn't have changed the outcome below.
- **Full memory scan (2559MB, 100% of readable regions) found ZERO
  `x'<hex>'` pattern matches** in the main WeChat process. Our own
  `extract_key.py`'s primary scan agrees (`raw_matches=0` for the WeChat
  process). Two independently-implemented scanners (raw Mach VM API vs
  lldb `ReadMemory`) agree: **the plaintext hex-encoded key string is not
  present anywhere in readable WeChat process memory on 4.1.11.23.**
  This isn't a memory-access-permission problem — the data simply isn't
  there to find, on either tool.
- Conclusion: switching extraction *tooling* doesn't help, because both
  tools rely on the same assumption (WCDB caches the derived key as a
  plaintext hex string) and that assumption no longer holds on current
  WeChat builds. A fix would need a fundamentally different technique —
  e.g. a breakpoint/hook at the exact moment the key is computed/used,
  before WCDB clears it. We already spent ~20 hours on Frida-based hooking
  for the (unrelated) send-message problem and hit a fully-stripped,
  zero-symbol binary — the same obstacle would apply here.
- No further action recommended until either Tencent's client changes
  again, or a new community technique specifically targeting key capture
  *at derivation time* (not memory scanning) surfaces. Reminder-to-retry
  bumped to ~2026-10-01 in `mcp_server.py`'s status docstring.

**Lead found 2026-10-11 (WeChat 4.1.15, build 270133): the breakpoint path was never tested.**
The July test ran only Thearas' `find_key_memscan.py`. The same repo's `find_key.py` is the
derivation-time capture this section asks for: it finds `setCipherKey` by its
`mov w0, #0x43` + `bl malloc` signature, breaks there, and reads the `x'<key><salt>'` string
from `x1+8`. [BIBOYANG425/wechat-chat-history-mac](https://github.com/BIBOYANG425/wechat-chat-history-mac)
(2 commits, April 2026) reports it working on 4.1.7, where memscan found 0/35 keys.

Static check on 4.1.15 (lldb on the files, no attach, no sudo):

- `MacOS/WeChat` is a 186 KB launcher with zero candidates. Upstream `find_key.py` only
  searches the module named `WeChat`, so it fails here as written.
- `Resources/wechat.dylib` (119 MB `__text`): 17 `mov w0, #0x43`, exactly one followed by
  `bl malloc`, in the function at file address `0x563e76c`.
- The launcher links only `libwxld.dylib`, so `wechat.dylib` loads after `main`.
  BIBOYANG425's patch (continue to `main`, then search) stops too early. Use a pending
  breakpoint that resolves when the dylib loads: `breakpoint set -a 0x563e76c -s wechat.dylib`.
  The address changes with every WeChat build; re-derive it each time.

Harness: `find_key_lldb.py` derives the address itself and verifies each key against the DB
headers (the function tests `size(x1)==0x63`, the length of `x'<96 hex>'`). `keytest.sh` runs it
plus ydotdog's scanner (same memory scan as `extract_key.py`). The address moved from `0x563e76c` to
`0x5645d04` within one day when WeChat auto-updated inside 4.1.15, so derive it every run.

**Live test 2026-10-11 (macOS 27.0.1, WeChat 4.1.15): FAILED, and the ad-hoc re-sign is now a dead end.**
After `codesign --sign -`, macOS shows "Data Access Blocked: WeChat tried to access your data from
other apps" (the container is tied to Tencent's team ID `5A4RE8SF68`), and WeChat exits at launch.
lldb attached and set the pending breakpoint (0 locations), then the process ended: 0 hits.
The July claim above ("re-sign alone was enough, SIP was never the blocker") no longer holds on this
OS. Matches BIBOYANG425's `docs/TROUBLESHOOTING.md` section 3. Without the re-sign, lldb gets
"Not allowed to attach" and `task_for_pid` returns 5, so ydotdog's scanner and our `extract_key.py`
cannot even read the process. Left open: the breakpoint path with SIP disabled (BIBOYANG425's
actual recommendation), untested; it needs a Recovery-mode reboot. Restore after a test:
`ditto ~/.wechat-export/keytest/WeChat.app.orig /Applications/WeChat.app`. One live run settles it:
re-sign (step 1), attach lldb, quit and relaunch WeChat, open chats so each DB opens. SIP
should not need disabling here (the July lldb attach worked on the re-signed app), but
BIBOYANG425 reports re-signed WeChat failing to launch on Sequoia, so check it launches
first.

## MCP Server

### Setup (one-time)

Create the local venv and install deps:

```bash
cd packages/wechat
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

The MCP config wires the local `run.sh` wrapper:

```json
"wechat": {
  "type": "stdio",
  "command": "${userHome}/code/personal/mcp-servers/packages/wechat/run.sh"
}
```

### Tools

| Tool | What it does |
|------|-------------|
| `wechat_query_chat` | Get messages for a contact/group, with optional date range filter |
| `wechat_search_messages` | Full-text search across all message databases |
| `wechat_list_contacts` | List/filter contacts by name, remark, or WeChat ID |
| `wechat_recent_activity` | Show recently active chats (last N days) |
| `wechat_voice_to_text` | Transcribe a voice message (.silk → wav → whisper) |
| `wechat_extract_keys` | Re-run key extraction (needs sudo configured for passwordless) |

All tools are read-only — the MCP server cannot send, edit, or delete messages.

### Key Management

The MCP server looks for keys in this order:
1. `/tmp/wechat_keys.json` — freshly extracted keys
2. `~/.wechat-export/.keys.json` — persisted backup

Keys become stale when WeChat restarts. When queries start failing, re-extract:

```bash
sudo python3 extract_key.py
```

---

## Why Sending Messages Doesn't Work

WeChat 4.x on macOS is locked down. We tried every approach — none worked reliably.
This section documents what was attempted so future-us doesn't repeat these dead ends.

### Approach 1: Keyboard Automation (AppleScript) — unreliable
**Tried**: March–April 2026, multiple iterations

The idea: Activate WeChat → Cmd+F → paste contact name → Down+Enter to select →
paste message → Enter to send. Uses clipboard for CJK text.

**Problems**:
- **Contact selection is broken.** Down+Down+Enter doesn't reliably select the first
  search result. WeChat's custom search UI doesn't respond to keyboard navigation
  the way standard macOS apps do. The keystrokes either do nothing, select the wrong
  result, or navigate the sidebar instead of the search dropdown.
- **No way to verify what's selected.** Because Accessibility API is dead (see below),
  there's no programmatic way to check which chat is actually open before sending.
- **OCR verification doesn't help.** We added screenshot + tesseract OCR to verify
  the correct chat opened after selection. But OCR checks the full window — it finds
  the contact name in the sidebar chat list, not because the correct chat is open.
  False positive every time.
- Briefly steals focus, won't work with modals, breaks on unexpected UI state.

### Approach 2: Frida Dynamic Tracing / Reverse Engineering — dead end
**Tried**: April 1–2, 2026. 18 script iterations (v1–v18), ~20 hours of effort.

Goal: Find WeChat 4.x's internal `SendMsg` function, call it directly via Frida
for true background sending with no UI interaction.

**What we mapped**:
- WeChat 4.x is a full C++ rewrite — no Objective-C, no `WCSessionMgr SendMsg:`
- Core binary `wechat.dylib`: 294MB total, 142MB ARM64, fully stripped, zero symbols
- Network call chain identified via Frida backtraces:
  - Kernel `write()`/`writev()` → write wrapper `+0x3241c`
  - Socket dispatch `+0x413420c` → serialization `+0x432f330`/`+0x4333c54`
  - High-level dispatch `+0x71004` → possible SendMsg entry `+0x3f0e168`
- 63 events captured across 14 unique backtraces during message send

**Why it failed**:
- Return addresses from backtraces = mid-instruction, not function entries
- Backward prologue scan (`stp x29, x30`) found callers, not callees
- Decoded `bl` targets were PLT/GOT stubs (trampolines), not real functions
- Ghidra OOM'd on the binary even with 8GB heap
- Got stuck in a restart-WeChat-ask-user-to-send-capture-repeat loop
- 18 iterations, zero callable function entries found

**Research**: Checked GitHub (Thearas 486★, cocohahaha, L1en2407/wechat-decrypt),
GitLab, Gitea, Chinese platforms. Nobody has solved programmatic sending on 4.x Mac.

### Approach 3: macOS Accessibility API — dead end
**Tested**: April 2, 2026

WeChat 4.x bypasses standard AppKit controls entirely. Custom rendering engine
(likely Skia). The Accessibility tree exposes only:
- 1 window ("Weixin")
- Close / minimize / fullscreen buttons
- 2 unnamed empty groups

Zero text fields, zero lists, zero buttons with labels. Nothing to interact with.

### Approach 4: Screenshot + OCR Verification — false positives
**Built and tested**: April 3, 2026

Added `screencapture` + `pytesseract` (chi_sim+eng) to verify the correct chat
opened before sending. OCR reads WeChat's custom-rendered text fine — contact names,
group names, message content all detected correctly.

**Problem**: OCR checks the full window and finds the contact name in the sidebar
chat list, not because the correct chat is open. Every verification is a false
positive. Couldn't reliably crop to just the chat header (window bounds vary,
WeChat has multiple windows, header region isn't consistent).

### Approaches Not Attempted

| Approach | Why not |
|----------|---------|
| **WeChatFerry** (C++ DLL injection) | Windows only, no macOS support |
| **WeChatPlugin-MacOS** (14.3k★) | Dead — only works on WeChat 3.x (ObjC era) |
| **Click by coordinates** | No reliable way to determine where search results render — varies by window size, monitor position, DPI |

### Conclusion

**Reading is fully solved.** Keys extracted from memory, all chats queryable in real-time.
Works with WeChat in background.

**Sending is not possible on WeChat 4.x Mac.** Tencent's C++ rewrite killed every
hook/inject path. The UI is a black box to both Accessibility API and Frida. Keyboard
automation can't reliably navigate the custom search UI. Until Tencent exposes an API
or someone cracks the binary, sending stays manual.
