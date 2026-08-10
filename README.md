# Rubato

**Claude Code in your browser — unzip, double-click `start.bat`, done.**

English | [中文](README_zh.md)

Rubato wraps Claude Code / Codex into a web-based multi-session task hub.
The problem it really cares about isn't "running several sessions" — it's
**getting people who have never set up a dev environment actually up and running.**

---

## You don't have to install anything first

This is the one thing that sets Rubato apart: **it does the setup for you.**

| What other tools ask you to do first | In Rubato |
|---|---|
| Install Node.js, fix your PATH | Missing? It downloads a portable copy into its own folder |
| `npm install -g @anthropic-ai/claude-code` | One click in the setup wizard, with a live progress bar |
| Install Git | Same — on Windows, no admin rights and no registry writes |
| Open a terminal and run `claude` to sign in | **Sign in from the web UI**: you get the link, four plain steps, and a box to paste the code into |
| Figure out yourself why nothing happens | A **network check** runs first and tells you exactly what's wrong and what to do |

So the real path from zero to working is three steps:

```
① Unzip  →  ② Double-click start.bat (or ./start.sh on macOS / Linux)  →  ③ Follow the wizard
```

The wizard has five steps: language & theme → **network check** → pick an engine → pick a model
provider → **sign in / paste an API key**. Anything missing can be installed or fixed right there —
you never end up staring at a blank screen wondering what went wrong.

---

## Can't reach Claude? You get a way out, not just an error

Rubato checks this in step two of the wizard and offers **two concrete ways forward**:

- **Use a VPN / proxy** → click "I've turned it on, check again";
- **No VPN at all** → switch to a China-based model (MiniMax / Kimi / Xiaomi MiMo).
  Only the providers that were **actually reachable at that moment** are offered, one click to switch.

The check isn't guesswork. It probes baseline sites, Claude's own endpoints and each provider
concurrently, and only asks "did we get an HTTP response at all" — a bare request to
`api.anthropic.com` returns 401/405, and that *is* the proof it's reachable. It also
**follows your `HTTPS_PROXY` through a CONNECT tunnel**, so people who already have a proxy running
don't get told they're offline.

---

## Signing in to Claude, from the browser

Stock Claude Code has to be signed in, or the messages you send get **no reply and no error at all**.
Rubato moves that into the web UI:

1. Click "Sign in to Claude" — the backend starts the official login flow and extracts the auth link;
2. The page gives you one big button that opens Claude's authorization page;
3. Sign in there and click Authorize — the page hands you an authorization code;
4. Paste it back and click Finish.

**This works even when the server is remote**: the link opens in *your* browser and the code is pasted
back by hand. Already signed in elsewhere, or using a third-party API key? The UI says
"not required" instead of making you jump through hoops.

---

## What else

- **Multi-session task queues** — queue up tasks per session and let them run in order; pause,
  interject, reorder, bulk-delete.
- **Full transparency** — the model's reasoning, every tool call with complete inputs and outputs,
  timings and token counts, all expandable.
- **File manager** — browse per workspace, edit in place, search, bookmark folders.
- **Failures are always visible** — engine failed to start, exit code 0 with zero output, long
  silence: each surfaces on screen with a reason and a suggested fix, instead of quietly doing nothing.
- **Cross-platform** — one codebase for Windows / macOS / Linux, with install paths branching per OS
  (brew on macOS; apt/dnf/yum/zypper/pacman/apk probed in turn on Linux; without root it hands you the
  exact `sudo` command to run).
- **Registries are measured, not guessed** — if you've configured an npm registry, yours is used
  untouched; otherwise the official registry and the China mirror are probed concurrently and the
  faster one wins.

---

## ⚠️ Security notice (please read first)

Rubato launches Claude Code / Codex subprocesses on your machine **with permission prompts bypassed
(`bypassPermissions`)** so tasks can run unattended. That means:

> **Anyone who can reach this web UI can read/write any file and run any command as you.**

So:

1. **It listens on `127.0.0.1` by default** — keep it that way. The "allow LAN access" setting binds
   `0.0.0.0`; only enable it on a network you trust.
2. **Never expose this service directly to the internet.** For remote access use an SSH tunnel or a
   VPN, always with HTTPS.
3. **You set the access password yourself** the first time you open the UI. There is **no built-in or
   default password**. It's stored as random-salt + sha256 in
   `projects/claude_hub/data/auth.json` (gitignored). Pick a strong one — it's the only thing standing
   in front of arbitrary command execution.
4. **API keys are entered by you** in Settings and stay in your local `data/`. No secrets ship in this repo.
5. `data/` holds sessions, keys and local settings — **don't commit it and don't share it.**
6. On a multi-user host: this service doesn't distinguish users. One password means full access.

Found a security issue? Please open an issue (or contact the maintainer privately) without publishing
exploitable details.

---

## Start / stop

| Platform | Start | Stop |
|---|---|---|
| Windows | double-click `start.bat` | double-click `stop.bat` |
| macOS / Linux | `./start.sh` | `./stop.sh` |

The `start` script runs the full self-check itself: is Node new enough, are dependencies installed, is
`backend/dist` older than the sources, is `data/` writable — it fixes what's missing and then opens
<http://localhost:8970>.

On macOS / Linux, make the scripts executable the first time:

```bash
chmod +x start.sh stop.sh
./start.sh
```

> If macOS says it "cannot be opened because it is from an unidentified developer", run `./start.sh`
> from a **terminal** (not by double-clicking in Finder), or allow it under
> System Settings → Privacy & Security.

Other details:

- If port 8970 is busy, `start` **runs stop first to free it** and continues; only if it's still busy
  does it stop and print the offending process.
- If the service crashes, the window stays open and prints the exit code — it won't flash and vanish.
- To keep it running on a server (needs pm2): `cd projects/claude_hub && bash restart.sh`.

---

## Layout

```
projects/claude_hub/
├── backend/src/
│   ├── logic_struct/    # Orchestration: only "who is called, in what order"
│   ├── logic_realize/   # Implementation: extends Struct, fills in the how
│   ├── helper/          # Pure utilities — business-free, independently testable
│   └── server/          # HTTP + WebSocket routes
├── frontend/            # Static frontend, no build step
├── out_end/             # Portable runtimes (downloaded on demand, not in git)
└── data/                # Sessions, keys, settings (not in git)
```

The code follows a Struct / Realize split: **"what it does" and "how it does it" live in separate
files**, so the orchestration reads top to bottom in one pass and changing a detail can't damage the
architecture. See `docs/SYSTEM_zh.md` and the diagram in `docs/architecture.svg`.

## License

[MIT](LICENSE)
