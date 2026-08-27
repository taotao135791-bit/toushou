# OMP GUI ↔ Oh My Pi RPC — Compatibility Facts

The GUI is a long-lived Desktop Host for two runtime generations. This file
records what is **verified**, against which version, and how the host absorbs
the differences. Sources of truth, in order: the installed binary's behavior,
its shipped type declarations, its bundled source. Facts below were verified
against **`@earendil-works/pi-coding-agent` 0.80.3** (legacy) and
**`@oh-my-pi/pi-coding-agent` 17.2.12** (current, installed by `omp.sh`).

## Runtime profiles

| | Legacy profile | Current profile |
|---|---|---|
| Package | `@earendil-works/pi-coding-agent` ≤ 0.84 | `@oh-my-pi/pi-coding-agent` (17.x) |
| Binary | `pi` | `omp` |
| First frame | none (silent until first command) | `ready` |
| Protocol | v1 JSONL only | v1 + v2 (negotiated) |
| Chunking | none | `rpc_chunk` above 1 MiB (v2) |
| Slash commands via `prompt` | forwarded to the agent | executed locally (`command_output`, `agentInvoked:false`) |
| Slash command list | `get_commands` | `get_available_commands` (+ `available_commands_update` push) |
| Compaction events | `compaction_start/end` | `auto_compaction_start/end` |
| Agent config | `~/.pi/agent/{settings.json,auth.json}` | `~/.omp/agent/{config.yml,*.db}` (see "Known gaps") |

## Bootstrap & negotiation (current profile)

- The runtime's first frame is exactly:
  `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}`
  — verified live. It is emitted before the stdin loop starts, so it always
  precedes any command response.
- The host answers `{id, type:'negotiate_protocol', protocolVersion:N}` with N =
  highest mutual version (`OmpHandshake`; GUI supports `[1,2]`). Success:
  `{type:'response', command:'negotiate_protocol', success:true, data:{protocolVersion:2}}`;
  v2 activates for frames sent **after** that response.
- An unsupported N is a clean failure (`success:false`, "Unsupported RPC
  protocol version: N"); the runtime stays usable. A runtime offering only v1
  needs no round-trip (v1 is the wire default). No common version → hard
  compatibility error naming both version lists.
- Negotiation is bounded (5 s) and falls back to v1 on timeout — every
  ready-capable runtime still speaks v1.
- Legacy runtimes answer `negotiate_protocol` with `success:false,
  "Unknown command: …"` and keep working — but the GUI never sends it to them:
  the absence of a `ready` frame settles the legacy profile on the first
  ordinary frame.

## Protocol v2 chunking (`rpc_chunk`)

For logical frames whose JSON exceeds `maxFrameBytes` (1 MiB), the runtime
splits the payload into chunk frames:

`{type:'rpc_chunk', chunkId, index, count, byteLength, data(base64)}`

Verified rules (upstream `RpcFrameDecoder`, cross-checked live with a 1.2 MB
`get_messages` response — 5 chunks, byte-exact):

- chunkId: non-empty string ≤ 128 chars, constant across the sequence;
- index/count: safe integers, count ∈ [2, 256], index starts at 0 and is
  strictly contiguous; any reorder/duplicate/gap/id-change is an error;
- byteLength: declared total UTF-8 size, ∈ [1 MiB, 64 MiB]; received bytes
  must equal it exactly at the end;
- data: strict base64 (alphabet + padding shape, decode→encode round-trip);
  each chunk's raw payload ≤ 256 KiB;
- a non-chunk frame mid-sequence is an "interrupted" error;
- the reassembled buffer must be fatal-UTF-8 JSON of an object.

The GUI's decoder (`OmpTransport.RpcFrameDecoder`) mirrors these exactly and
drops all partial state on any violation — a malformed sequence never wedges
the stream and never reaches the renderer half-parsed.

**Outgoing** commands are always single physical lines: the runtime's stdin
reader accepts oversize lines (verified with a 2 MiB command), so the host
never chunks its writes.

## Prompt lifecycle (current profile)

- `prompt` acks **immediately**; `success:true` is receipt, not completion.
- `data.agentInvoked === false` → the prompt completed locally (slash
  command). No `agent_start`/`agent_end` follow. The result text arrives as
  `{type:'command_output', text}`. A deferred `{type:'prompt_result', id,
  agentInvoked}` frame may also settle this.
- `data` absent/null (or `agentInvoked:true`) → the agent runs; the normal
  event stream follows.
- Mid-stream agent prompts without `streamingBehavior` get **two** response
  frames with the same id: the ack, then `success:false` ("Agent is already
  processing…"). A rejection is not a turn-terminal condition.
- `follow_up`-queued messages run as additional turns inside the same agent
  run; one `agent_end` closes the whole run.
- Local commands mid-stream execute immediately and do not disturb the
  running turn.

## Agent lifecycle events (both profiles)

- `agent_start` / `agent_end {messages}` — terminal event of a run.
  Current runtimes may send `agent_end` with `isTerminal:false` ("an async
  delivery will resume the session before its true final settle") — that is
  NOT turn completion; only `isTerminal !== false` settles a turn.
- `turn_start` / `turn_end` — per model round-trip (several per run when
  follow-ups are queued).
- `message_update.assistantMessageEvent`: `text_delta`/`thinking_delta` are
  the streamed payloads.
- `message_end.message.stopReason === 'error'` carries `errorMessage` — the
  only place provider failures surface (the process exits 0 regardless).
- `tool_execution_start/update/end` carry a stable `toolCallId`; concurrent
  tools complete out of order — pair strictly by id.
- Current-only session events the GUI maps: `auto_compaction_start/end`
  (→ legacy compaction events), `auto_retry_start` (→ one info line),
  `retry_fallback_applied` (→ info line), `notice` (warning/error only),
  `command_output` (→ system message).
- Current-only frames the GUI deliberately ignores (forward-compatible):
  `available_commands_update`, `session_info_update`, `config_update`,
  `model_changed`, `thinking_level_changed`, `goal_updated`, `todo_*`,
  `ttsr_triggered`, `irc_message`, `host_tool_call/cancel`,
  `host_uri_request/cancel`, `subagent_lifecycle/progress/event`
  (gated by `set_subagent_subscription`, default off).

## Extension UI

`extension_ui_request {id, method, …}` — interactive:
`select|confirm|input|editor` (answer with `extension_ui_response`).
`notify` becomes a bounded system message and needs no response. Current adds
`cancel {targetId}` (dismisses a pending dialog) and
`open_url {url, launchUrl?, instructions?}`. An extension URL is never opened
automatically: the host renders a validated, explicit transcript link and
only the user's click may open the system browser. Extension URLs are HTTPS,
or HTTP loopback (`localhost` / `127.0.0.1`) for OAuth-style flows.

`setStatus`, `setWidget`, `setTitle`, `set_editor_text`, and unknown UI
methods are explicitly unsupported. The host emits one visible diagnostic per
method per session, sends no fabricated response, and keeps the runtime
stream alive. See `docs/extension-host-contract.md` for the full host
contract, bounds, and future GUI-contribution policy.

## Commands used by the GUI

Both profiles: `prompt` · `steer` · `follow_up` · `abort` · `get_state` ·
`set_model` · `set_thinking_level` · `compact` · `get_session_stats` ·
`export_html` · `get_messages` · `set_session_name`.
Current-only renames the GUI probes with fallback: `get_available_commands`
(legacy: `get_commands`). Response failures may carry a machine-readable
`code`.

`get_state` extras on current runtimes (tolerantly parsed, all optional to
the GUI): `queuedMessageCount`, `fastModeEnabled/Active`, `tokensPerSecond`,
`todoPhases`, `contextUsage`, `steeringMode`, `followUpMode`, `interruptMode`.

## Subagent bridge (verified 17.2.12)

The current runtime exposes a subagent graph over RPC. Verified against the
installed `@oh-my-pi/pi-coding-agent` 17.2.12 source (`src/modes/rpc/*`,
`src/task/types.ts`) and cross-checked live via `integration/omp/subagent.compat.test.ts`.

**Commands (current profile only):**

- `set_subagent_subscription { level }` — level ∈ `"off" | "progress" | "events"`.
  Response `{ command, success:true, data:{ level } }`. `progress` emits
  `subagent_lifecycle` + `subagent_progress`; `events` additionally emits raw
  child `subagent_event` frames. The GUI subscribes at **`progress`** (never
  `events` — raw child token/transcript streams must not flood the main renderer).
- `get_subagents` → `{ subagents: RpcSubagentSnapshot[] }`. The roster is a
  **live-only** snapshot: a terminal lifecycle deletes the agent from the
  registry, so completed/failed/aborted agents that finished before the GUI
  attached are absent (upstream limitation, documented).
- `get_subagent_messages { subagentId?, sessionFile?, fromByte? }` →
  `{ sessionFile, fromByte, nextByte, reset, entries, messages }`. `fromByte`/
  `nextByte` support incremental reads; a `fromByte` past EOF resets to 0
  (`reset:true`). An unknown `subagentId`/`sessionFile` is a clean `success:false`.

**Snapshot / payload fields (exact):**

`RpcSubagentSnapshot`: `id, index, agent, agentSource, description?, status,
task?, assignment?, sessionFile?, lastUpdate, progress?, parentToolCallId?`.
`agentSource` ∈ `"bundled" | "user" | "project"`. `status` is `AgentProgress.status`
∈ `"pending" | "running" | "completed" | "failed" | "aborted"`.

`subagent_lifecycle.payload`: `id, agent, agentSource, description?, status,
sessionFile?, parentToolCallId?, index, detached?` — `status` ∈
`"started" | "completed" | "failed" | "aborted"`. `started` maps to `running`
(upstream `statusFromLifecycle`).

`subagent_progress.payload`: `index, agent, agentSource, task, parentToolCallId?,
assignment?, progress: AgentProgress, sessionFile?, detached?`. `AgentProgress`
carries `id, status, task, lastIntent?, currentTool?, toolCount, …`.

**No subagent control RPC exists in 17.2.12** — there is no `kill`, `revive`,
`park`, `unpark`, or subagent-steer command. The internal registry has `idle`
and `parked` states, but those are NOT exposed over RPC (`get_subagents` only
carries `AgentProgress.status`). The GUI's `subagentControl` capability is
therefore `unsupported`; `subagentProgress`/`subagents`/`subagentMessages` flip
to `supported` only after a live RPC response confirms them.

## Session files

`~/.omp/agent/sessions/--<cwd with / → ->--/<ISO-ts>_<uuid>.jsonl` (legacy:
`~/.pi/agent/sessions/…`). First line `{type:'session', id, timestamp, cwd}`,
then append-only entries. Resume: `--session <path>` — verified on 17.2.12
(get_messages + continued prompting work).

## Known gaps (documented, not worked around)

- **Agent config storage moved**: current omp keeps auth/model defaults in
  `~/.omp/agent/agent.db` / `models.db` (SQLite) and `config.yml`; it no
  longer reads `settings.json`/`auth.json` (verified: a legacy-format
  `auth.json` is ignored). The GUI's file-based provider-key management and
  default-model persistence are legacy-profile features; with a current
  runtime, keys come from the environment or `omp` itself. The GUI surfaces
  the upstream RPC `login` / `open_url` state machine in Settings, including
  browser, input, select and confirm prompts.
- **Model catalog discovery**: legacy ships a single generated registry file
  the GUI reads for the settings picker; current omp builds the registry
  from per-provider sources + `models.db`. The picker falls back to the RPC
  `get_available_models` list (credential-filtered) — fully functional, just
  not browse-before-you-have-a-key.
- `get_messages_page` (v2 cursor pagination) exists upstream; the GUI still
  uses whole-transcript `get_messages` (chunked transport makes it safe).

## Approval extension contract (resources/omp-approval)

Extensions load via `-e file.ts`. `api.on('tool_call', (event, ctx) => …)`
may return `{block: true, reason}`; `ctx.ui.select/confirm/input` surface as
`extension_ui_request` over RPC. Config via `OMP_APPROVAL_CONFIG` env →
per-session JSON `{mode: 'off'|'writes'|'all', locale}` re-read
(mtime-cached) per tool call.

## Test entry points

- `pnpm test` — unit suite (transport, handshake, protocol, session, fsGuard…).
- `pnpm test:omp` — real-binary compatibility suite (`integration/omp/`):
  drives the installed `omp` (and `pi`, when present) through the GUI's own
  session layer. Needs a configured runtime (API key in the environment or a
  logged-in agent). Override binaries with `OMP_BIN` / `PI_BIN`.
