# Architecture

OMP GUI is a **Desktop Host** for Oh My Pi (pi). It deliberately does **not**
reimplement the agent runtime — it owns the process, the wire, the desktop UX,
and the security boundary.

```
Electron Renderer (React)
    ↓ contextBridge IPC (typed, contextIsolation + sandbox)
Electron Main
    ↓ src/main/omp/*
Oh My Pi RPC  (omp|pi --mode rpc)
    ↓
OMP Runtime (agent, models, tools, extensions, sessions)
```

## Desktop Host responsibilities

- **Process lifecycle** — spawn/kill the runtime per session, stderr ring
  buffer, crash recovery (pending queries resolve, dialogs cancel, transcript
  survives on disk and can be resumed from History).
- **RPC transport** — `OmpTransport`: strict LF-only JSONL with a
  StringDecoder (multi-byte safe), 16 MB physical frame guard, and the
  protocol v2 `RpcFrameDecoder` that reassembles `rpc_chunk` sequences with
  upstream-exact validation (see `docs/protocol-facts.md`).
- **Bootstrap & compatibility** — `OmpHandshake`: detects the runtime profile
  from the first frame (`ready` → current Oh My Pi; anything else → legacy
  Pi), negotiates the highest mutual RPC protocol version, and fails loudly
  with both version lists when there is no common one. `OmpProtocol`
  normalizes both profiles onto one event surface, so the renderer never
  sees protocol versions or renamed events.
- **Session routing** — every event carries the stable GUI session id; the
  explicit `SessionRuntimeState` machine
  (`starting/idle/working/waiting_for_user/aborting/failed/closed`) decides
  when a turn is truly terminal (`agent_end` without `isTerminal:false`, a
  local-only prompt settle, or a provider error) — the queue only drains
  then. Rejected commands surface as errors but never settle a turn.
- **IPC & security boundary** — `fsGuard` canonicalizes roots and targets
  with realpath so symlinks can't escape the project; provider credentials
  live only in the runtime's own store, never in the renderer.
- **Desktop UX** — composer, sessions, plugins, permissions, notifications,
  updates, i18n.

## OMP (omp/pi) responsibilities

agent reasoning · model registry · tool execution (parallel by default, with
stable `toolCallId`) · extensions/skills/prompts · session persistence ·
compaction · provider auth.

> The GUI must not reimplement OMP runtime capabilities. When a capability is
> missing upstream, the UI degrades honestly instead of faking it.

## Rendering pipeline

```
Assistant Markdown
  ↓ fenced code language
Rich Renderer Registry (src/renderer/lib/richRenderers.ts)
  ↓ known language
Mermaid Renderer (src/renderer/lib/mermaid.ts — lazy import, serialized
  theme-aware renders, sandbox cleanup, error → source fallback)
  ↓ otherwise
CodeBlock
```

Tool calls render through `ToolRendererRegistry`
(`src/renderer/components/tools/`): bash (terminal panel), read, edit/write
(diff-colored), generic JSON fallback for extension tools.

## Chat → Office edit proposals (```office-edit)

The workbook sibling of the board-cards protocol, following the same
interaction iron law as `docs/plugin-board-foundation.md` §4: an agent never
modifies a workbook silently — it proposes, a person confirms, then the app
applies.

1. "Ask agent about this workbook" drafts a bounded, reviewable composer
   prompt (`buildOfficeChatPrompt`, never auto-sent) that also teaches the
   protocol: after analysis, the agent may answer with exactly one
   ```` ```office-edit ```` JSON fence — `{ "version": 1, "edits": [...],
   "note"? }`, 1–200 edits, A1-style cells, string/number/boolean values.
2. The fence parses in `src/shared/officeEdit.ts` (strict envelope, lenient
   per edit, unknown fields dropped, all-invalid fails) and renders in chat
   as a preview table (`OfficeEditProposalBlock`). A string value starting
   with `=` is rejected at parse time — Univer would treat it as a formula,
   so proposals can never smuggle formulas into a sheet.
3. **Apply** in chat only STAGES the proposal: it is stored in the
   renderer's `officeEditHandoff` (and the Office workspace panel is opened
   if it was closed). The panel shows a second confirm bar; only the person
   clicking Apply there writes the values — via the Univer API into the
   **in-memory workbook instance** (exact sheet-name lookup, cell bounds
   checked against the sheet grid, per-edit failure report).
4. **Nothing in this path touches the filesystem.** Applied edits leave the
   workbook dirty in the panel; persistence still flows exclusively through
   the user's own open/save-as FileGrants (native dialogs minted by Main).
   Ignoring the proposal — in chat or in the panel — discards it entirely.

## Error surfacing

Provider/transport failures surface from `message_end.errorMessage` (the
runtime exits 0 on provider errors — see protocol facts). Process crashes
surface with the stderr tail and leave the session resumable. Transport
errors (oversize frame, malformed chunk sequence) are contained to the
session, never crash the app. A runtime whose RPC protocol has no common
version with the GUI fails the session with an explicit compatibility error
(detected vs supported versions), not a JSON parse error.
