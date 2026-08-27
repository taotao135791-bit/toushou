# DeepSeek Harness Adoption

This file records how DeepSeek Harness was used as an architecture / UI / reuse
reference for OMP GUI, and — critically — what was **not** imported. It is the
adoption matrix required before any cross-project reuse.

> **Guiding rule:** Oh My Pi is the only agent runtime. DeepSeek Harness is a
> reference and a source of reusable MIT code, never a second runtime. The goal
> is a desktop GUI that makes Oh My Pi's real capabilities observable — not a
> "DeepSeek Harness wearing OMP".

## Pinned reference snapshot

| | |
|---|---|
| Repository | `deepseek-ai/deepseek-harness` |
| Branch | `master` |
| Commit SHA | `47f943859bef60e4160492346772ded9b24f765a` |
| Commit date | 2026-08-13 |
| License | MIT (`Copyright (c) 2026 DeepSeek`) |

All source reuse, architecture comparison and test comparison in this pass are
based on this snapshot. Do not follow upstream `master` while developing.

## Adoption matrix

Reuse modes: `DIRECT_DEPENDENCY`, `VENDORED_SOURCE`, `ADAPTED_SOURCE`,
`REFERENCE_ONLY`, `SKIP`.

| Capability | DSH source | OMP equivalent | Reuse mode | Runtime owner | Decision |
|---|---|---|---|---|---|
| Atomic file write | `packages/util/atomic-write` | `electron-store` + ad-hoc `writeFileSync` | VENDORED_SOURCE | OMP GUI | Vendored `writeFileAtomic` for GUI-owned metadata sidecars (`src/main/lib/atomicWrite.ts`). |
| Output retention / spill | `packages/util/output-retention` | renderer renders full tool output | ADAPTED_SOURCE | OMP GUI | Adapted `TextRetainer` head/tail to line-oriented `headTailLines` (`src/renderer/lib/retention.ts`). |
| Timeout helpers | `packages/util/timeout` | Node `setTimeout` inline | SKIP | OMP GUI | No current gap its `AbortSignal` fusion solves. |
| Branded id types | `packages/util/brand` | plain string ids | SKIP | OMP GUI | Type-only nicety, no runtime benefit here. |
| Session projection | `packages/session/*` | renderer `SessionEvent` stream | REFERENCE_ONLY | OMP GUI | Borrowed the *fold + view* pattern; reimplemented as `src/renderer/lib/execution.ts`. |
| Subagent runtime | `packages/subagent/*` | OMP `subagent_*` RPC events | REFERENCE_ONLY | **Oh My Pi** | Only OMP subagents are used. DSH subagent runtime is never imported. |
| Subagent UI | `packages/client/ui-subagent` | (new) Agent Hub | REFERENCE_ONLY | OMP GUI | UX reference; the Agent Hub is built on `execution.ts`. |
| Trajectory UI | `packages/client/ui-trajectory` | (new) trajectory overview | REFERENCE_ONLY | OMP GUI | Borrowed grouping/timing concepts; reimplemented on OMP events. |
| Plan / Todo | `packages/plan`, `packages/todo`, `ui-plan` | OMP `todo_*`/`goal_*` events | REFERENCE_ONLY | **Oh My Pi** | OMP plan/todo events are the truth; no GUI-only task planner. |
| Jobs | `packages/jobs`, `ui-jobs` | OMP async work (subagents/commands) | REFERENCE_ONLY | **Oh My Pi** | No second job runtime; project OMP async work only. |
| Session query / search | `packages/session-query` | sidebar session search | REFERENCE_ONLY | OMP GUI | FTS/index design reference; implementation stays local-only over OMP session files. |
| Terminal | `packages/terminal` | OMP DAP/REPL (if any) | REFERENCE_ONLY | **Oh My Pi** | Not introduced; no second agent terminal runtime. |
| Agent loop / LLM / tools / LSP / sandbox / shell | `packages/core`, `llm`, `tool-*`, `code-runtime`, `lsp`, `sandbox`, `fs`, `shell` | OMP runtime | SKIP | **Oh My Pi** | Forbidden — OMP owns all of this. |
| Cordis DI/plugin kernel | `@deepseek-ai/cordis` | — | SKIP | — | Forbidden — no second plugin/DI kernel. |
| Credentials / settings / session persistence | `packages/credentials`, `settings`, `session/*` | OMP native auth + `~/.omp/agent` | SKIP | **Oh My Pi** | Forbidden — OMP owns credential/settings/session truth. |
## Code reused directly / adapted

### VENDORED_SOURCE — `src/main/lib/atomicWrite.ts`

- **Source:** `packages/util/atomic-write/src/index.ts`
- **Why not a dependency:** the npm package's `invariant.ts` companion depends
  on `@deepseek-ai/cordis`; the useful `writeFileAtomic` core is self-contained
  (`node:crypto`, `node:fs/promises`, `node:path`) and too small to justify a
  dependency edge.
- **Changes:** removed `withFileLock` (unused) and the Cordis companion; kept
  `writeFileAtomic` verbatim with an MIT header.
- **License:** MIT notice retained (header + `THIRD_PARTY_NOTICES.md`).

### ADAPTED_SOURCE — `src/renderer/lib/retention.ts`

- **Source:** `packages/util/output-retention/src/index.ts` (`TextRetainer`)
- **Why not verbatim:** upstream is byte-oriented (`Uint8Array` + `TextDecoder`)
  for process/body safety; the renderer already holds a decoded JS string, so a
  line-oriented head/tail is the natural fit and is UTF-8-safe by construction.
- **Changes:** `headTailLines(text, headLines, tailLines)` with an exact
  hidden-line count and a `formatHiddenLines` notice.
- **License:** MIT notice retained (header + `THIRD_PARTY_NOTICES.md`).

### ADAPTED_SOURCE — `src/renderer/lib/execution.ts` (pattern only)

- **Source:** `packages/session/session-stats/src/projection.ts` (fold + view)
- **Why not verbatim:** DSH folds DSH events (`step/start`, `tool/call`, …); OMP
  GUI folds its own normalized `SessionEvent` surface. The *pattern* — a pure
  `apply` fold with a `view` selector, `Object.is`-gated change feed — was
  borrowed, not the code.

## Runtime boundaries

```
Oh My Pi (omp|pi --mode rpc)
  = agent loop · reasoning · models · tools · subagents · LSP/DAP · memory ·
    skills · extensions · compaction · permissions · runtime state · sessions
        │  (OMP RPC: ready → negotiate_protocol → prompt/steer/tool_* …)
        ▼
OMP GUI Desktop Host (Electron main)
  = process lifecycle · transport · handshake · IPC · fsGuard · native auth UI ·
    settings adapters · approval · checkpoints · updater
        │  (typed contextBridge IPC, contextIsolation + sandbox)
        ▼
OMP GUI Renderer (React + Zustand)
  = visualization · interaction · projection · observability · workspace UX ·
    persistence of GUI-owned metadata
```

OMP GUI never spawns an agent, never calls a model, never runs a tool, and never
persists a session transcript itself — it only **projects** what OMP emits.
The new execution projection (`src/renderer/lib/execution.ts`) is part of the
renderer's projection layer, **not** a runtime.

## New architecture (projection layer)
## Capability gating (what OMP actually exposes — verified 17.2.12)

| Capability | Status | Basis |
|---|---|---|
| Subagent roster | **supported** | `get_subagents` answers (live-only roster). Verified live in `integration/omp/subagent.compat.test.ts`. |
| Subagent progress events | **supported** | `set_subagent_subscription('progress')` accepted; `subagent_lifecycle`/`subagent_progress` normalize onto one `subagent` event. |
| Child transcript | **supported** | `get_subagent_messages` answers (incremental `fromByte`/`nextByte`); never merged into the root transcript. |
| Subagent control (kill/revive/park/steer) | **unsupported** | No such RPC exists in 17.2.12 (`subagentControl` stays `unsupported`). |
| Plan / Todo | **unknown** | OMP emits `todo_*` / `goal_updated`; the GUI does **not** invent a plan from Markdown. |
| Persistent terminal | **unsupported in this pass** | No second terminal runtime. |
| Session full-text search | **future** | Local-only FTS over OMP session files. |

Anything `unknown`/`unsupported` is rendered honestly (no dead buttons), never
faked.

## Stage 1 — Core truth cleanup

1. **Hermetic subprocess env** — `envMode: 'inherit' | 'replace'` on
   `makeExecRunner`, `RuntimeRpcClient.spawn`, `planSpawn`; integration replaces.
2. **Role selector thinking suffix** — `src/shared/modelSelector.ts`
   (`parseModelSelector` / `switchModelSelector`): `provider/model:high` →
   `{ modelSelector, thinkingOverride }`, and switching the default model keeps
   the role-level override (`A:high → B:high`).
3. **Steer explicit modeling** — `MessageLike.kind: 'prompt' | 'steer'`; steer
   also records a trajectory entry INSIDE the active turn (`foldUserSteer`).
4. **recentProjects bootstrap race** — hydrated once, MRU write guarded.
5. **Per-turn metadata** — `runtimeModel`/`runtimeThinking` reconstructed from
   OMP `get_state`/`get_messages` where possible; a GUI sidecar is the fallback
   for GUI-only metadata (documented, not yet needed).

## Stage 2/3 — Subagent bridge + multi-turn projection (this round)

**Host (main process):**
- Typed `OmpSession` methods + facade wrappers for `set_subagent_subscription`,
  `get_subagents`, `get_subagent_messages`.
- Post-handshake bootstrap: on a `current`-profile session the host subscribes
  at `progress` and hydrates the roster — a subscription failure never fails the
  session.
- `CliCapabilities` gains `subagents` / `subagentProgress` / `subagentMessages` /
  `subagentControl`, flipped only by REAL RPC responses (never guessed).
- Typed IPC + preload for `getSubagents` / `getSubagentMessages` (no arbitrary
  command passthrough; no kill/revive since none exists).

**Projection (renderer):**
- `execution.ts` rewritten to multi-turn: `ExecutionProjection = { agents,
  turns, turnOrder, currentTurnId }`. Agents are session-scoped (flat roster +
  root); turns are prompt-scoped (fresh `TurnProjection` per `agent_start`,
  per-turn tool counts / reasoning / trajectory).
- EXACT status mapping `normalizeOmpAgentStatus` (no substring guessing; unknown
  → `unknown`).
- `classifyToolCall` is the single tool classifier; the legacy chat row maps onto
  it (one classification source).
- `applyAgentRoster` merges `get_subagents` snapshots through the SAME
  `upsertAgent` reducer as live events — one graph, not two.

**Output retention:** `RetainedOutput` now wraps bash/read/generic tool output —
large outputs render head + hidden-count + tail by default, with a
keyboard-reachable expand to the full text. `retention.ts` is now actually used.

**Now available:** a compact, conditional in-chat Agent Activity disclosure shows
the live/durable child roster, status/telemetry, the latest trajectory facts, and
a read-only child-transcript action. It uses the existing projection rather than
creating another execution state machine.

**Still future work:** a dedicated Agent Hub tree/focus surface, a virtualized
full trajectory timeline, interrupt/revive controls (upstream does not expose
them anyway), and a search index.

## Stage 4 — Final runtime truth cleanup (this round)

1. **Capability semantics** — a normalized `RpcOutcome<T>` distinguishes
   `success` / `command-error` / `unsupported` / `unknown`. A runtime
   `success:false` that is NOT `Unknown command:` PROVES the command exists
   (`supported`) — an invalid child / permission / state error never downgrades
   the capability. Timeout / transport / death / malformed → `unknown`, never
   `unsupported`. Verified live: `get_subagent_messages(does-not-exist)` → 
   `command-error`, `subagentMessages` stays `supported`.
2. **Tool/Turn stats single source** — removed the authoritative `turnActivity`
   / `turnSummaries` store state and their writers. The chat turn row now derives
   live progress and the frozen summary via `turnActivityFor` / `turnSummaryFor`
   selectors from `ExecutionProjection` (the single classifier `classifyToolCall`
   feeds both). No second counter store remains.
3. **Historical metadata resume** — model/thinking are RECONSTRUCTED from OMP's
   durable session JSONL (`model_change` / `thinking_level_change` entries,
   replayed per user prompt) via `reconstructSessionMetadata`; steer is
   reconstructed from the `steering` flag on `get_messages`. **No GUI sidecar is
   needed** — OMP's durable log is sufficient. Unknown stays unknown (never the
   current/default model).
4. **Retention line + size** — `isLargeText` uses line-count OR character-count,
   and `headTailChars` retains a single enormous line surrogate-safe (emoji/CJK
   never split). `RetainedOutput` now also covers the generic tool INPUT.
5. **Agent ownership** — `endTurn` no longer mutates `agents`; the root agent is
   a synthetic graph root (derived status), not a roster entry. A turn may end
   while its subagent keeps running — only subagent lifecycle/progress/snapshot
   events change agent status.
6. **Bootstrap dedup** — the handshake bootstrap now only sets the subscription;
   the renderer hydrates the roster once via `getSubagents()`, no discarded
   duplicate request.

## Stage 5 — Final runtime truth hardening (this round)

1. **id-less Unknown Command correlation** — pending requests carry their command
   type; an id-less `Unknown command: X` response is correlated ONLY to a UNIQUE
   pending request of that command (never guessed across multiple, never from a
   non-"Unknown command" error). `parseUnknownCommandError` is a strict parser.
2. **Capability preservation** — `featureMatrix` no longer owns subagent
   capability state, so a `get_state` refresh never resets a proven
   `supported`/`unsupported` back to `unknown`. Subagent capabilities flip only
   on a real RPC outcome.
3. **Branch-aware session replay** — `reconstructSessionMetadata` now walks the
   ACTIVE path (leaf → root via `parentId`, cycle-protected), mirroring OMP's
   `buildSessionContext`, so a rollback/fork never leaks abandoned-branch
   model/thinking/steer into the active transcript.
4. **Root lifecycle** — the main agent is a living session with a derived
   `RootAgentStatus` (`active`/`idle`/`waiting`/`error`/`disconnected`), never a
   child `completed`/`failed`/`aborted`.
5. **Agent telemetry + sparse merge** — `AgentNode` preserves OMP's
   `resolvedModel`/`durationMs`/`tokens`/`cost`/`contextTokens`/`contextWindow`/
   `retryState`/`retryFailure`/`recentTools`/`currentTool`/`lastIntent`; merges
   use `mergeDefinedFields` so a missing field never erases confirmed truth.
6. **Durable historical agents** — `reconstructHistoricalAgents` rebuilds
   blocking children from upstream `SingleResult` records and background
   children from the real `AgentProgress` snapshot + persisted `async-result`
   delivery + child session artifact. These records merge through the SAME
   `upsertAgent` reducer; stale progress never becomes a fake running or
   terminal state, and missing timestamps remain unknown.

## Stage 6 — Repository hardening (this round)

P0 runtime truth (id-less Unknown Command correlation, get_state capability
preservation, branch-aware session replay) was already in place and is retained.
This round closed the remaining filesystem / IPC / installer / release
boundaries:

- **Git symlink containment** — untracked-file line counts and synthetic diffs
  resolve real paths; a workspace symlink pointing outside the workspace is never
  read through (shown as `symlink → outside workspace`).
- **Session history realpath** — `isSessionFilePath` verifies real-path
  containment, so a `session.jsonl -> /outside/file` symlink is never resumed.
- **Workspace root validation** — `FS_SET_ROOT` accepts only real, existing
  directories; roots originate from the native folder dialog or persisted
  recent workspaces (the renderer never grants itself arbitrary authority).
- **Installer trust** — HTTPS-only host allowlist (`omp.sh` / GitHub), redirect
  host validation, max script size.
- **Image IPC validation** — `sanitizeImages` enforces count / MIME allowlist /
  base64 shape / per-image and total decoded-byte caps (in a pure
  `imageValidation` module).
- **Package manifest traversal** — manifest `pi.*` resource paths that escape the
  package dir are rejected.
- **Notification privacy** — completion notifications default to a generic body;
  response previews are opt-in (`notificationPreviews`).
- **CI / release** — `.github/workflows/ci.yml` (typecheck + test + build +
  gitleaks + optional `test:omp`), `.github/workflows/release.yml`
  (signs/notarizes only when secrets are configured), `build/entitlements.mac.plist`
  + `electron-builder.json` hardened-runtime entitlements, and README security /
  signing documentation.

## License compliance

See `THIRD_PARTY_NOTICES.md`. Every reused source file carries its own MIT
header with the source commit, and no upstream header was deleted. `retention.ts`
(adapted) and `atomicWrite.ts` (vendored) are in active use.

## Performance

- The projection is an immutable fold gated by `Object.is` (no-op events return
  the same reference), so Zustand selectors can memoize.
- The multi-turn fold only touches the current turn / the changed agent; it never
  deep-clones whole-session history per event.
- Large tool outputs are head/tail retained in the DOM by default, so a 4 MB
  output never materializes as tens of thousands of nodes.

## Remaining OMP upstream limitations

These are strictly **OMP runtime does not expose it** — not OMP GUI missing:

- Subagent kill/revive/park/unpark/steer (no RPC in 17.2.12; `idle`/`parked`
  exist only in the internal registry, not the RPC surface).
- A durable roster of already-completed subagents (`get_subagents` is live-only;
  terminal agents are dropped from the registry).
- Plan/todo as first-class runtime events (events exist; exact schema not yet
  confirmed against a live runtime).
- Persistent per-agent PTY (no confirmed terminal tool surface).

These are **OMP GUI future enhancements**:

- A dedicated Agent Hub tree/focus mode/breadcrumb on top of the existing
  in-chat activity disclosure.
- Full trajectory overview virtualization beyond the latest in-chat facts.
- Session full-text search index.


```
Oh My Pi
   │  OMP RPC (SessionEvent — normalized by src/main/omp/OmpProtocol.ts)
   ▼
Normalized Runtime Events
   │  foldExecutionEvent (one fold, pure)
   ▼
Execution Projection  (sessionId → { agents, tools, trajectory })
   ┌────┼────┬────┬─────┐
 Chat  Agents Trajectory Plan Jobs
               │
            Session Query (future)
```

The same normalized fact stream feeds every surface; no surface keeps its own
copy of history. Chat continues to use the existing message list; the Agent Hub
and trajectory overview derive from `executions[sessionId]` selectors.
