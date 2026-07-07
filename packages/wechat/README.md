# WeChat Mac — Decrypt, Export & MCP Server

Scripts to extract SQLCipher keys from WeChat's process memory, export chat history,
and run a **read-only** MCP server for live chat queries.

## Files

| File | Purpose |
|------|---------|
| `extract_key.py` | Extracts encryption keys from WeChat memory (requires sudo) |
| `export_messages.py` | Batch export all messages/contacts to JSON + Markdown |
| `mcp_server.py` | MCP server — live chat queries, contact search, voice transcription (read-only) |

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
| WeChat won't launch after re-sign | Reinstall from wechat.com, then re-sign |
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
