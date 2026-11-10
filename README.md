# mcp-servers

[![CI](https://github.com/Mingz6/mcp-servers/actions/workflows/ci.yml/badge.svg)](https://github.com/Mingz6/mcp-servers/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP (Model Context Protocol) servers that give AI coding agents, GitHub Copilot in VS Code and Claude Code, the same inboxes and tools I use every day: Teams, Outlook, iMessage, WhatsApp, WeChat, Telegram, Discord, LinkedIn, Xiaohongshu, IMAP mail, a Markdown knowledge wiki and a job runner.

![npm run demo: brain-mcp answers a search and a backlinks query over stdio](docs/demo.gif)

*`npm run demo` starts brain-mcp against the made-up wiki in [`examples/sample-brain/`](examples/sample-brain/) and calls two of its tools, the way an agent would. No accounts or API keys.*

Write-up: [mingz.dev/projects/mcp-servers](https://mingz.dev/projects/mcp-servers/)

## Why it exists

I run most of my day through agent chats: a morning scan of every channel, replies drafted in my voice, PR review asks, a task board. An agent is only as useful as what it can read. For the channels I actually use, servers either didn't exist (WeChat, iMessage with an SMS fallback, Xiaohongshu) or wanted broad tokens and sent messages on their own. These are small, run locally over stdio, and keep a person in front of anything that goes out.

## Quick start

Needs Node 22 or newer (CI runs 22 and 24). This part needs no accounts:

```bash
git clone https://github.com/Mingz6/mcp-servers.git && cd mcp-servers
npm ci
npm run build   # every Node server, TypeScript strict
npm test        # brain-mcp, msgraph and outlook unit tests
npm run demo    # brain-mcp on examples/sample-brain, two tool calls over stdio
```

Python servers keep their own virtualenv:

```bash
cd packages/imessage    # or linkedin, telegram, wechat, xiaohongshu
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest test_mcp_server
```

Then register the servers you want with your client. Each one starts through its `run.sh`, which finds nvm's Node or the package's `.venv`:

```bash
claude mcp add brain -e BRAIN_MCP_ROOT=$HOME/notes -- $PWD/packages/brain-mcp/run.sh
```

```jsonc
// VS Code mcp.json
{
  "servers": {
    "brain": {
      "type": "stdio",
      "command": "${userHome}/code/mcp-servers/packages/brain-mcp/run.sh",
      "env": { "BRAIN_MCP_ROOT": "${userHome}/notes" }
    }
  }
}
```

Logins are per server and covered in each package's README: a device code for Microsoft, a QR scan for WhatsApp and Xiaohongshu, phone and OTP for Telegram, a one-time headed browser login for LinkedIn.

## Servers

| Server | Language | Talks to | What an agent can do | Status |
|---|---|---|---|---|
| [msgraph](packages/msgraph/) | TypeScript | Microsoft Graph, work account | Teams chats, meetings and transcripts; Outlook mail with attachments; Loop pages; a one-way calendar copy to the Mac | daily use |
| [outlook](packages/outlook/) | TypeScript | Microsoft Graph, personal Outlook.com | read, search and send mail, attachments | daily use |
| [imap-mail](packages/imap-mail/) | TypeScript | IMAP (Gmail, QQ Mail, ...) | read, search, attachments; one instance per account | daily use |
| [imessage](packages/imessage/) | Python | macOS Messages (`chat.db` + AppleScript) | read, search, send; resends as SMS when Apple refuses an iMessage | daily use |
| [whatsapp](packages/whatsapp/) | JavaScript | WhatsApp Web via Baileys | read, search, send | daily use |
| [wechat](packages/wechat/) | Python | WeChat for Mac (SQLCipher database or screen OCR) | read, search, voice-note transcripts; read-only | daily use |
| [telegram](packages/telegram/) | Python | Telegram user API via Telethon | read, search, send | daily use |
| [discord-user](packages/discord-user/) | TypeScript | Discord, as the user | read servers and DMs; read-only, never sends | daily use |
| [linkedin](packages/linkedin/) | Python | linkedin.com via Patchright | inbox, send, people search, profiles, posts | daily use |
| [xiaohongshu](packages/xiaohongshu/) | Python | xiaohongshu.com via a headless browser | search, feed, post detail, comments | daily use |
| [brain-mcp](packages/brain-mcp/) | TypeScript | A local Markdown wiki | keyword and semantic search, backlinks, link graph, guarded edits | daily use |
| [flywheel](packages/flywheel/) | TypeScript | GitHub repos I learn from | track repos, detect changes, scout new patterns | daily use |
| [worker-center-mcp](packages/worker-center-mcp/) | TypeScript | worker-center's SQLite database | worker status, price history, job pipeline | daily use |
| [teams-chat](packages/teams-chat/) | TypeScript | Microsoft Graph | Teams only; msgraph covers it for agents | legacy, still feeds a scheduled scan |
| [ms-loop](packages/ms-loop/) | TypeScript | Microsoft Graph | Loop only; msgraph covers it | legacy |
| [msgraph-auth](packages/msgraph-auth/) | TypeScript | MSAL | shared device-code login, token cache, cross-process sign-in lock | library |

Third-party servers (context7, Azure DevOps) run through [`scripts/npx-nvm.sh`](scripts/npx-nvm.sh), which loads nvm's Node before `npx`.

## Architecture

```mermaid
flowchart LR
  copilot["VS Code Copilot"] -- stdio --> wrapper
  claude["Claude Code"] -- stdio --> wrapper
  wrapper["run.sh per server<br/>nvm Node or .venv Python"] --> graphServers & chatServers & webServers & localServers

  subgraph packages
    graphServers["msgraph, outlook"]
    chatServers["imessage, whatsapp, telegram,<br/>wechat, discord-user, imap-mail"]
    webServers["linkedin, xiaohongshu"]
    localServers["brain-mcp, flywheel,<br/>worker-center-mcp"]
  end

  graphServers --> auth["msgraph-auth<br/>MSAL device code + token cache"] --> graph[("Microsoft Graph")]
  chatServers --> chats[("chat.db, SQLCipher DB,<br/>Baileys, Telethon, Discord, IMAP")]
  webServers --> browser[("persistent browser profile")]
  localServers --> files[("Markdown wiki, SQLite")]
```

## Decisions and trade-offs

- **One repo, one package per server.** One lockfile and one build, but each server starts on its own, so an expired WeChat key never takes Teams down. The cost: `npm ci` installs everything (about 150 MB) even if you want one server.
- **Local stdio only.** No HTTP listener, so there is no port to secure; the client spawns the server with the environment it needs. The cost: everything runs on one machine, and a second machine runs its own copies.
- **`run.sh` wrappers.** Clients start servers with a minimal environment (no shell profile), so the wrapper finds nvm's Node or the package's `.venv` and, where a server needs them, loads its secrets. Upgrading Node doesn't break the client config.
- **Read-only where the platform's terms are grey.** Discord (a user token) and WeChat never send. The send tools that do exist expect a person to approve first; in my setup a pre-tool hook blocks a direct send and stages the message in an outbox for review.
- **One Microsoft login for three surfaces.** msgraph merged teams-chat, the work half of outlook, and ms-loop because they shared one app registration. msgraph-auth adds a cross-process lock so two clients starting at once don't both pop a device-code prompt.
- **Browser automation only where there is no API.** LinkedIn and Xiaohongshu drive a persistent browser profile. It is slow and breaks when the site changes, so those servers stay small.
- **No secrets in the repo.** `.env` files are gitignored, and GitHub secret scanning with push protection is on.

## Status

Built for my own Macs and used every day. imessage and wechat need macOS; the rest run anywhere Node or Python does. Nothing is published to npm or PyPI: clone the repo and point your client at the `run.sh` you want. CI builds and tests every Node package on Node 22 and 24 and runs the Python unit tests on every push and pull request.

## Adding a server

1. Create `packages/{name}/` with its own `package.json` (Node) or `requirements.txt` (Python), a `run.sh` and a README.
2. Add it to the table above.
3. Register its `run.sh` with your client.

## Troubleshooting

- **A server won't start:** run its wrapper by hand (`./packages/brain-mcp/run.sh`); it says what's missing, such as a `.venv` or an env var.
- **VS Code paths:** use `${userHome}` in `mcp.json`, not `~`.
- **npx-based servers:** try `scripts/npx-nvm.sh -y <package>` by hand.
- **WeChat:** re-extract the database key with `sudo python3 packages/wechat/extract_key.py` after a WeChat update.

## License

[MIT](LICENSE)
