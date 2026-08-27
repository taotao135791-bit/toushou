# AdPilot

A desktop-native advertising optimization agent: plan, launch, analyze, and optimize ad campaigns from a native app.

Built on the OMP agent runtime (see Settings for runtime details), with sessions, checkpoints, plugins, and boards inherited from a battle-tested desktop host.

## Build

```bash
pnpm install
pnpm dev        # run from source
pnpm package    # build the desktop app
```

The app auto-detects the agent runtime, or offers to install it on first run.

## Features

- **Session persistence** — sessions survive restarts: the sidebar's History section lists pi's on-disk sessions per project (titled by the first message), one click resumes the process and backfills the full transcript, then keeps chatting right where you left off.
- **Session titles & Chinese-first** — sessions auto-name from your first message (header and sidebar show the real title, not the folder name), and when the UI is Chinese the agent is instructed to reply in Chinese.
- **Live turn progress** — while the agent works, a single line reports what it's doing ("正在读取 calc.py · 已读取 3 个文件 · 已执行 2 条命令"); when the turn ends it freezes into a collapsible "已处理 7.2s · …" summary with the tool list tucked behind it. Collapsible thinking blocks show the model's reasoning with elapsed time.
- **Message-level actions** — hover a user message to copy, edit-and-resend, or roll the code back; model tag included.
- **Composer status bar** — tokens / cache hit / context fill / cost on the left, key hints on the right; a permission-mode pill switches Ask ↔ Full access live for the running session.
- **Codex-style layout** — sidebar with sessions & projects, streaming chat in the middle, file tree + preview on the right. Chinese/English UI, light & dark themes.
- **Checkpoints & rollback** — every prompt snapshots the git worktree (no touch to your index, stash or refs). Hover any user message to roll the code back to before that message; the chat history stays put.
- **Message queue & steering** — keep typing while the agent works: Enter queues, each queued card can steer mid-turn or be deleted; the queue drains automatically when the turn ends.
- **Per-tool approval** — the bundled omp-approval extension asks before bash/edit/write in the new "Ask" permission mode (Allow once / Always allow / Deny), with per-session config files so parallel sessions never clobber each other. Classic modes (full / no-bash / read-only) remain.
- **Changes view & git chip** — a Changes tab in the right panel lists worktree changes with +add/−del and a full diff per file (untracked files synthesized); the chat header shows the current branch and total diffstat, refreshing after every turn.
- **Session list that scales** — search, pin, archive, working/unread status dots, and a system notification when a turn finishes in the background (click to jump to the session).
- **Composer power-ups** — `@` fuzzy file references, image paste & attach (up to 4×10MB), a thinking-level picker (off/low/medium/high) synced with the live session, and self-teaching placeholders.
- **Auto-update** — checks GitHub Releases on launch and from Settings → About; downloads in the background and installs on restart.
- **Session export** — one click exports the transcript to a styled HTML file in ~/Downloads.
- **Model & provider sign-in** — Settings → Authentication lists every provider the runtime reports (66+), with its real connection state. Connect runs Oh My Pi's **native login flow** (browser OAuth or paste-key prompt, validated by the provider itself); Sign out removes the credential through the official channel with read-after-write verification. The GUI never stores keys itself, and never pretends a write succeeded when the runtime didn't confirm it. Legacy Pi installs keep their file-based auth.json compatibility path.
- **Runtime-faithful models & thinking** — the composer model picker lists only models the runtime can actually run (credential-filtered by Oh My Pi itself) and switches **exactly the current session**; without a session it sets a one-shot override for the next session's spawn args. The Settings default (for future sessions) is a separate control persisted to `modelRoles.default` (never `enabledModels`) — changing one never moves the other, and every write is verified by re-reading the runtime. The session thinking picker covers the full session enum (off → **max**) filtered by the current model's own capability list; the Settings default-thinking picker uses the separate config enum (`auto` … `max`, no `off`), and both display the runtime-resolved level.
- **Zero legacy writes on current OMP** — with a current Oh My Pi runtime, no Settings/auth/models/skills flow ever touches legacy `auth.json`/`settings.json` (guarded by static-boundary tests and a real-filesystem integration check). Legacy Pi installs keep their file-based compatibility path, clearly labeled legacy in the UI.
- **Permissions** — tool access modes (full access / no Bash / read-only) applied to new sessions, plus project-trust control for project-local plugins.
- **Assemble your Pi** — the plugin page works like a mecha bay: drag parts onto the core to mount them, drag back to the rack to detach, drop to the red zone to uninstall. The install field accepts whatever you paste — a GitHub `owner/repo` shorthand or repository URL (including `/tree/<ref>` branch links), an npm name or versioned spec, or a local folder dropped straight from Finder — and Main normalizes it into the runtime's native form before installing. Only mounted parts load into new chats, keeping pi lean.
- **Discover & build plugins** — curated picks and a live search of the npm `pi-package` ecosystem sit right on the plugin page, one click to install. Nothing fits? The "build your own" entry starts a chat that scaffolds a pi extension or skill for you.
- **Write your own plugin** — the built-in plugin studio lets you author a TypeScript extension right in a dialog: **Save** keeps the source in the app-owned store, **Save & sync** links it into the runtime for the next session, and **Delete** unlinks first, then removes the source (with confirmation). Handwritten sources live under opaque app-managed ids, never renderer-supplied paths.
- **Kimi Computer Use bridge** — with the separate [Kimi CU](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html) desktop app installed, the Plugins page can wire it in as a computer-use MCP server: OMP GUI detects the app, checks its background service plus Accessibility/Screen Recording permissions, probes its stdio MCP endpoint, and — only after a native confirmation — writes its own `omp-gui-kimi-cu` entry into `~/.omp/agent/mcp.json` (every other entry is preserved, and an externally modified entry is never overwritten). Without Kimi CU installed, the page simply points you to the official download; nothing is bundled or auto-installed.
- **Boards that talk to chat** — a free-form widget canvas (notes, todos, counters, gauges, line/bar charts, clocks, links) with always-on drag/resize, CSV/XLSX dataset binding, and a describe-to-compose flow. Every widget's look is tunable — accent/surface/text/border colors, corner radius, padding, title alignment, shadow — through a validated token model, so a board file can never smuggle in CSS, URLs, or scripts. The chat handoff is explicit in both directions: **Ask agent** drops a privacy-bounded board summary into the composer (widget summaries and dataset schemas, never raw rows or note bodies — review, then send), and any assistant reply can be saved back onto a board as a note widget after you pick the board and confirm.
- **Clean skill scope** — chats load only pi's own abilities plus your mounted packages. Skills other agents installed on this machine (`~/.agents/skills`) are excluded by default via pi's `!<name>` override list, with an opt-in toggle in Settings.
- **Usage monitor** — a corner chip tracks the live session: total tokens, prompt-cache hit rate, context-window fill (amber/red as it fills) and cost. Compaction shows a live indicator in the header and the chip; `/compact` squeezes the context on demand.
- **Slash commands** — type `/` in the composer for a searchable menu of everything the session offers (extension commands, prompt templates, skills from your installed packages), with keyboard navigation.
- **Interactive plugin dialogs** — when an extension asks (select / confirm / input / editor), a real dialog pops up in the chat instead of hanging the agent.
- **Tool call visualization** — `read`, `bash`, `edit` and custom tool calls rendered as expandable cards.
- **Mermaid diagrams** — assistant responses with ```mermaid fenced blocks render as sandboxed SVG diagrams (flowcharts, sequence, state, gantt…), theme-aware, with a source/diagram toggle and graceful source fallback on parse errors.
- **Hardened host** — runtime-detected RPC compatibility (legacy Pi and current Oh My Pi), protocol negotiation with `rpc_chunk` reassembly for large frames, an explicit session state machine (queue drains only on terminal completion), tool results matched by `toolCallId` (parallel-safe), and realpath-based filesystem sandboxing that stops symlink escapes. See `docs/architecture.md` and `docs/protocol-facts.md`.

## RPC compatibility

OMP GUI does not depend on one frozen snapshot of the Oh My Pi RPC protocol.
At session start it detects which runtime it is talking to and adapts:

- **Current Oh My Pi** (`omp`, the `omp.sh` lineage) — reads the `ready`
  frame, negotiates the highest mutually supported RPC protocol (v1/v2), and
  reassembles `rpc_chunk`ed frames larger than 1 MiB losslessly. Local slash
  commands, `agent_end isTerminal:false` maintenance ends, and auto-retry /
  auto-compaction events are all understood.
- **Legacy Pi** (`pi` ≤ 0.84) — no handshake exists; the first ordinary frame
  settles the classic v1 JSONL profile.

Both profiles normalize onto one event surface, so the UI never cares which
runtime — or which protocol version — is underneath. If a future runtime
speaks a protocol this app can't, the session fails with an explicit
compatibility message (both version lists), not a parse error. Settings →
About shows the detected version, the negotiated protocol, and the runtime's
supported versions. The tested matrix lives in `docs/protocol-facts.md`; the
real-binary suite runs with `pnpm test:omp`. Native OMP/Pi packages and any
future GUI contribution have deliberately separate boundaries; see
`docs/extension-host-contract.md`.

## Settings & authentication compatibility

Settings are runtime-faithful: **GUI says Connected = the runtime is actually
authenticated; GUI says Model X = the runtime is actually using Model X.**

- **Current Oh My Pi** — providers and their auth state come from
  `get_login_providers`; sign-in rides the runtime's native login flow
  (browser/key prompt, provider-validated); defaults live in the runtime's
  own config (`modelRoles.default`, `defaultThinkingLevel`,
  `skills.enableAgentsUser`), written via `omp config` and verified by
  re-reading the runtime. `enabledModels` is a separate model allow-list the
  GUI never touches when you set the default model.
- **Legacy Pi** — keeps the file-based compatibility path
  (`auth.json` / `settings.json`), clearly labeled as legacy in the UI.

The GUI never maintains its own credential store, static model database, or
"saved successfully" states the runtime didn't confirm. Domain details live
in `docs/settings-auth.md`.

## Tech Stack

- Electron + Vite
- React + TypeScript
- Tailwind CSS
- Zustand
- Lucide icons

## Development

Prerequisites: Node.js 18+, pnpm, and [Oh My Pi](https://omp.sh) or Pi CLI on `PATH`.

> Important: the shell environment may set `ELECTRON_RUN_AS_NODE=1`, which breaks Electron. The `dev` script unsets it automatically.

```bash
pnpm install
pnpm dev
```

## Contributing

Use a focused branch and pull request for every change. `CONTRIBUTING.md`
defines the review, compatibility, and release process; `AGENTS.md` records
the working agreement for human contributors and coding agents. Security,
runtime, IPC, persistence, and release changes need code-owner review. The
maintenance contract for the plugin and board surfaces (intake forms,
handwritten sources, the Kimi CU bridge, board styling and chat handoff)
lives in `docs/plugin-board-foundation.md`.

The repository does not yet declare an open-source license. The project owner
must make that legal decision before inviting external redistribution or
contributions; see `CONTRIBUTING.md`.

## Security

- **Electron boundary** — `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. The renderer talks to the host only through the typed
  contextBridge API; there is no `invoke(command, args)` escape hatch.
- **Workspace authorization** — filesystem reads go through `FsGuard`, a
  realpath-canonicalized root allowlist. Roots come from user-selected folders
  (native dialog) or persisted recent workspaces; the renderer can't grant
  itself arbitrary filesystem authority.
- **Session-history capabilities** — the renderer receives opaque, expiring
  history ids rather than transcript paths. Resume/delete are bound to the
  listing window and current workspace grant, then revalidate canonical file
  identity before OMP or disk access.
- **Package-code authorization** — package rows and local selections are
  short-lived Main-owned capabilities; install, update, remove and
  enable/disable actions require a native confirmation instead of trusting a
  renderer-supplied source path.
- **Symlink containment** — Git changes, session history and project-file reads
  resolve real paths, so an in-workspace symlink pointing outside the workspace
  is never read through (its target content is not exposed).
- **Installer trust** — the auto-installer downloads from an HTTPS host
  allowlist (`omp.sh` / GitHub), refuses redirects to untrusted hosts, and caps
  the script size.
- **Notifications** — completion notifications default to a generic body
  ("Agent turn finished."). Response previews are opt-in and may appear in the
  OS notification center / lock screen.
- **Signing** — see below.

## Signing & notarization

Unsigned development builds are self-signed (ad-hoc) and may be quarantined by
macOS Gatekeeper (`xattr -cr`). For a distributable release, `pnpm package`
reads these environment variables; omit them to produce an unsigned build:

```bash
CSC_LINK=…                      # base64 .p12 or path to the Developer ID cert
CSC_KEY_PASSWORD=…              # cert password
APPLE_ID=…                      # Apple ID (for notarization)
APPLE_APP_SPECIFIC_PASSWORD=…   # app-specific password (notarization)
APPLE_TEAM_ID=…                 # team id (notarization)
```

`build/entitlements.mac.plist` supplies the hardened-runtime entitlements.
`.github/workflows/release.yml` signs/notarizes only when the matching secrets
are configured — certificates and passwords are never committed.

## Test & Build

```bash
pnpm test         # vitest unit tests (hermetic, no real omp/pi)
pnpm test:omp     # real-binary RPC + settings fidelity suite (isolated, credential-free, non-destructive)
pnpm test:omp:live  # OPTIONAL live provider smoke test — may consume tokens; not run in CI
pnpm build        # type-check + bundle
pnpm package      # electron-builder → release/
```

`pnpm test:omp` is **isolated and token-free**: it creates a fresh temp
`PI_CODING_AGENT_DIR` + temp `HOME` per test, strips provider credentials,
and never runs live model inference — so your real auth, config and token
quota are untouched. `pnpm test:omp:live` is opt-in only (set
`OMP_GUI_RUN_LIVE_TESTS=1`); it may use configured provider credentials and
consume tokens, so it is never invoked automatically.

### Publishing a release

Pushing a tag that exactly matches `v` plus `package.json`'s version triggers
the Release workflow:

```bash
git switch main
git pull --ff-only
git tag vX.Y.Z
git push origin vX.Y.Z
```

The workflow reruns typecheck, unit tests, and the pinned OMP compatibility
suite; builds both macOS architectures; verifies the DMGs, ZIPs, update
manifest, and blockmaps; generates `SHA256SUMS.txt`; then creates or updates
the GitHub Release. Do not manually upload a partial set of updater assets.
See `CONTRIBUTING.md` for the full release checklist.

## Project Structure

```
omp-gui/
├── electron.vite.config.ts    # electron-vite configuration
├── package.json
├── integration/
│   └── omp/                   # real-binary RPC compatibility suite (test:omp)
├── src/
│   ├── main/                  # Electron main process
│   │   ├── index.ts           # window lifecycle
│   │   ├── ipc.ts             # IPC handlers
│   │   ├── omp/               # host layer: process, transport, handshake,
│   │   │                      # protocol normalization, session, capabilities
│   │   ├── packages.ts        # package install/link/remove + source normalization
│   │   ├── managedPlugins.ts  # handwritten plugin sources (save/sync/delete)
│   │   ├── kimiComputerUse.ts # optional Kimi CU MCP bridge
│   │   ├── boards.ts          # board persistence + validation
│   │   ├── boardDatasets.ts   # CSV/XLSX dataset import for boards
│   │   ├── piSettings.ts      # pi settings.json / auth.json
│   │   ├── preload.ts         # contextBridge API
│   │   └── store.ts           # electron-store persistence
│   ├── renderer/              # React frontend
│   │   ├── components/        # Layout, Sidebar, ChatPanel, ExtensionUiDialog, …
│   │   ├── pages/             # ChatPage, BoardsPage, PackagesPage, PluginAuthorPage, SettingsPage, SetupWizard
│   │   ├── store/             # Zustand store
│   │   └── i18n.ts            # Chinese/English dictionaries
│   └── shared/                # constants + types shared across processes
└── tailwind.config.js
```

## Notes

- The GUI detects `omp` first and falls back to `pi` if omp is not installed.
- If no CLI is found, the "New Chat" button is disabled and a setup wizard offers auto-install.
- pi itself has no built-in tool approval prompts; coarse permission modes work by passing `--exclude-tools` to new sessions, and the "Ask" mode's per-call prompts come from the bundled `resources/omp-approval` extension, which hooks pi's `tool_call` event and asks through the GUI's dialog bridge.
- Plugin installs (npm/GitHub/local, plus handwritten-plugin sync) ride on the runtime's own `omp plugin` commands, which need [bun](https://bun.sh) on `PATH`. The GUI searches the default installer location `~/.bun/bin` even when the app was launched from Finder.
- Auto-update runs through electron-updater against GitHub Releases. Unsigned (ad-hoc) builds are quarantined by macOS Gatekeeper, so Settings → About offers the download page as a one-click fallback; signed/notarized releases (when the signing env vars are configured) install without the quarantine workaround.
- Completion and approval-waiting notifications are standard macOS notifications; the first one triggers the system's permission prompt, which decides whether later ones arrive. Completion notifications default to a generic body — response previews are opt-in (`notificationPreviews`) and may appear on the lock screen.
