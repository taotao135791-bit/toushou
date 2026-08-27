export interface CliInfo {
  command: string
  /** Resolved absolute path to the executable, when found. */
  path?: string
  version?: string
  available: boolean
}

/**
 * Feature surface of the detected CLI, for the settings page. Probed via
 * `--version` plus runtime session bootstrap: the RPC fields are declared
 * by the runtime's `ready` frame and the negotiated protocol (see
 * src/main/omp/OmpHandshake.ts, docs/protocol-facts.md).
 */
export interface CliCapabilities {
  /** Parsed `<cli> --version` output; null when the probe failed. */
  cliVersion: string | null
  /** Negotiated RPC protocol version; 1 until a session bootstraps v2. */
  protocol: number
  /** Runtime family detected at session bootstrap (absent before any session). */
  profile?: 'legacy' | 'current'
  /** RPC versions the runtime advertised in its ready frame. */
  protocolVersions?: number[]
  /** Runtime-declared physical frame limit, bytes. */
  maxFrameBytes?: number
  /** Runtime-declared reassembled logical frame limit, bytes. */
  maxReassembledFrameBytes?: number
  steering: boolean
  followUp: boolean
  images: boolean
  compaction: boolean
  extensionUi: boolean
  fork: boolean
  thinking: boolean
  /**
   * Subagent capabilities, probed from REAL RPC responses — never guessed from
   * the `current` profile. Each is 'unknown' until a live session proves it:
   * - subagents: `get_subagents` answers (roster hydration).
   * - subagentProgress: `set_subagent_subscription` to 'progress' is accepted.
   * - subagentMessages: `get_subagent_messages` answers.
   * - subagentControl: kill/revive/steer-subagent RPC exists (not in 17.2.12).
   */
  subagents: CapabilityState
  subagentProgress: CapabilityState
  subagentMessages: CapabilityState
  subagentControl: CapabilityState
}

/** Subagent subscription levels (`set_subagent_subscription`). */
export type SubagentSubscriptionLevel = 'off' | 'progress' | 'events'

/** Agent definition source. */
export type SubagentAgentSource = 'bundled' | 'user' | 'project'

/** Normalized subagent status (mirrors `AgentProgress.status` + lifecycle). */
export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted'

/** Raw lifecycle phase carried by `subagent_lifecycle` payloads. */
export type SubagentLifecyclePhase = 'started' | 'completed' | 'failed' | 'aborted'

/** One entry of the `get_subagents` roster. */
export interface SubagentSnapshot {
  id: string
  index: number
  agent: string
  agentSource: SubagentAgentSource
  description?: string
  status: SubagentStatus
  task?: string
  assignment?: string
  sessionFile?: string
  lastUpdate: number
  parentToolCallId?: string
  /** Aggregated progress, when the runtime supplied it (nested, verbatim). */
  progress?: SubagentTelemetry
}

/**
 * Observability telemetry OMP exposes on `AgentProgress` / `SingleResult`. The
 * GUI preserves these fields rather than throwing them away at the wire edge —
 * future Agent Hub rows render model / duration / tokens / cost / context /
 * retry / intent / current tool from them. All optional, all verbatim shapes.
 */
export interface SubagentTelemetry {
  resolvedModel?: string
  resolvedModelIsFallback?: boolean
  modelRole?: string
  durationMs?: number
  requests?: number
  tokens?: number
  cost?: number
  contextTokens?: number
  contextWindow?: number
  retryState?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; startedAtMs: number }
  retryFailure?: { attempt: number; errorMessage: string }
  lastIntent?: string
  currentTool?: string
  toolCount?: number
  recentTools?: Array<{ tool: string; args: string; endMs: number }>
}

/** Result of an incremental `get_subagent_messages` read. */
export interface SubagentMessagesResult {
  sessionFile: string
  fromByte: number
  nextByte: number
  reset: boolean
  /** Raw session entries (opaque to the GUI; mapped to messages below). */
  entries: unknown[]
  /** Mapped agent messages. */
  messages: unknown[]
}

/** Selector for `get_subagent_messages` (one of subagentId / sessionFile). */
export interface SubagentTranscriptSelector {
  subagentId?: string
  sessionFile?: string
  fromByte?: number
}

/**
 * A subagent reconstructed from OMP's durable task result, async-result
 * delivery, and/or child session artifact (not the live `get_subagents`
 * roster). Lets a resumed session show its historical children even when the
 * live roster is empty. A record is `unknown` when durable data proves the
 * child existed but does not prove a terminal outcome.
 *
 * Timestamp rule: startedAt/endedAt are only populated when the durable runtime
 * record supplies real timestamps. A record that only carries durationMs keeps
 * startedAt/endedAt undefined — never fabricate Date.now() values.
 */
export interface HistoricalAgentRecord {
  id: string
  agent: string
  agentSource: SubagentAgentSource
  status: SubagentStatus | 'unknown'
  index?: number
  source?: 'task-result' | 'async-result' | 'child-session'
  task?: string
  assignment?: string
  description?: string
  lastIntent?: string
  resolvedModel?: string
  resolvedModelIsFallback?: boolean
  modelRole?: string
  /** Real start timestamp (epoch ms) when the runtime recorded one. */
  startedAt?: number
  /** Real end timestamp (epoch ms) when the runtime recorded one. */
  endedAt?: number
  durationMs?: number
  tokens?: number
  requests?: number
  contextTokens?: number
  contextWindow?: number
  cost?: number
  resultSummary?: string
}

/**
 * A Main-owned filesystem capability. The renderer cannot mint one; it can only
 * request activation of a workspace that originated from a trusted source.
 */
export interface WorkspaceGrant {
  /** Stable grant id used by the renderer for workspace-sensitive IPC. */
  id: string
  /** Canonical real path of the workspace (symlinks resolved). This is the path
   * passed to OMP/FsGuard/Git. */
  realPath: string
  /** Path shown in the UI (may be the original selected path before realpath). */
  displayPath: string
  /** How this grant was authorized. */
  source: 'dialog' | 'recent-project' | 'session' | 'runtime'
  /** Epoch ms when the grant was created. */
  createdAt: number
}

/**
 * A short-lived, Main-held capability for one user-approved file operation.
 * The canonical path is deliberately never exposed to the renderer.
 */
export interface FileGrant {
  /** Opaque id; valid only for the declared purpose. */
  id: string
  purpose: 'board-dataset-import'
  /** Display-only basename supplied by Main after the user picks/drops it. */
  name: string
  createdAt: number
}

/**
 * A short-lived, Main-held capability for one user-approved directory write.
 * Main exposes only a non-authoritative folder label; it resolves the id to
 * its private canonical path immediately before writing.
 */
export interface DirectoryGrant {
  /** Opaque id; valid only for the declared purpose. */
  id: string
  purpose: 'plugin-scaffold'
  /** Display-only basename supplied by Main; never an authorization path. */
  name: string
  createdAt: number
}

/** Main-owned recent workspace entry. The id is opaque to the renderer. */
export interface RecentWorkspaceDescriptor {
  id: string
  displayPath: string
  name?: string
}

/**
 * A normalized outcome of one RPC command round-trip, so capability probing can
 * distinguish "the command exists but this invocation failed" from "the command
 * does not exist":
 *
 * - `success` / `command-error`: the runtime ANSWERED the command → it exists
 *   (supported), regardless of whether this invocation succeeded.
 * - `unsupported`: the runtime answered `Unknown command: …` → not implemented.
 * - `unknown`: no usable answer (timeout, transport failure, process death, or a
 *   malformed response) → capability stays unknown, never "unsupported".
 */
export type RpcOutcome<T> =
  | { kind: 'success'; data: T }
  | { kind: 'command-error'; error: string; code?: string }
  | { kind: 'unsupported'; error?: string; code?: string }
  | { kind: 'unknown'; error?: string }

/**
 * Runtime lifecycle of a session's agent process, driven by RPC events
 * (see src/main/omp/OmpSession.ts for the transition table).
 *
 * The renderer maps these to busy explicitly (working/waiting_for_user/
 * aborting → busy; idle/failed → not busy) and ignores unknown values
 * defensively. The main process currently only emits 'working' and 'idle'.
 */
export type SessionRuntimeState =
  | 'starting'
  | 'idle'
  | 'working'
  | 'waiting_for_user'
  | 'aborting'
  | 'failed'
  | 'closed'

export interface Session {
  id: string
  cwd: string
  title: string
  createdAt: number
  status: 'idle' | 'running' | 'error'
  /** Session file this session was resumed from, if any. */
  resumeFrom?: string
  /** pi's on-disk session file (backfilled after spawn; used to dedup history). */
  sessionFile?: string
  /** Opaque history capability that this renderer session resumed, if any. */
  resumedHistoryId?: string
}

export type SessionEvent =
  | { type: 'connected'; sessionId: string }
  | { type: 'message'; sessionId: string; role: 'user' | 'assistant' | 'system'; content: string }
  /** Streaming thinking delta of the in-flight assistant message. */
  | { type: 'thinking'; sessionId: string; delta: string }
  /** `id` is pi's stable toolCallId — parallel tool runs must be matched by it. */
  | { type: 'tool_call'; sessionId: string; id?: string; tool: string; input: unknown; output?: unknown }
  | { type: 'tool_result'; sessionId: string; id?: string; tool: string; output: unknown; isError: boolean }
  /**
   * `isTerminal` is only meaningful on agent_end-derived idle events: pi
   * 0.80.3 has no such field (agent_end is always terminal → true); a future
   * upstream may send explicit `false` for non-terminal ends.
   */
  | { type: 'status'; sessionId: string; status: SessionRuntimeState; isTerminal?: boolean }
  | { type: 'compaction'; sessionId: string; phase: 'start' | 'end' }
  /** `recoverable` is false when the session process died (crash/exit). */
  | { type: 'error'; sessionId: string; message: string; recoverable?: boolean }
  | {
      type: 'ui_request'
      sessionId: string
      id: string
      method: 'select' | 'confirm' | 'input' | 'editor'
      title: string
      message?: string
      options?: string[]
      placeholder?: string
      prefill?: string
      timeout?: number
    }
  /** The extension dismissed a pending dialog; drop the matching ui_request. */
  | { type: 'ui_cancel'; sessionId: string; id: string }
  /** Runtime resolved a new thinking level (may differ from the requested one). */
  | { type: 'thinking_level_changed'; sessionId: string; level?: string }
  /** The session's model changed (set_model / fallback); refetch get_state. */
  | { type: 'model_changed'; sessionId: string }
  /**
   * A subagent (child agent) state update, normalized from upstream
   * `subagent_lifecycle` and `subagent_progress` frames onto ONE event surface.
   * Both frame kinds upsert the same node: lifecycle carries the phase
   * (started/completed/failed/aborted), progress carries aggregated task/tool
   * facts. `id` is OMP's stable registry id — never the label or array index.
   * Emitted only when the runtime's subagent subscription is enabled (see
   * `set_subagent_subscription`); the roster is hydrated separately via
   * `get_subagents` so a late-attached GUI still sees agents it missed.
   */
  | {
      type: 'subagent'
      sessionId: string
      id: string
      agent: string
      agentSource: SubagentAgentSource
      description?: string
      /** Normalized status; lifecycle 'started' arrives as 'running'. */
      status: SubagentStatus
      /** Raw lifecycle phase, present on lifecycle-derived events. */
      phase?: SubagentLifecyclePhase
      task?: string
      assignment?: string
      sessionFile?: string
      parentToolCallId?: string
      index?: number
      detached?: boolean
      /** Aggregated progress facts (from `subagent_progress` / `AgentProgress`). */
      lastIntent?: string
      currentTool?: string
      toolCount?: number
      resolvedModel?: string
      resolvedModelIsFallback?: boolean
      modelRole?: string
      durationMs?: number
      requests?: number
      tokens?: number
      cost?: number
      contextTokens?: number
      contextWindow?: number
      retryState?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; startedAtMs: number }
      retryFailure?: { attempt: number; errorMessage: string }
      recentTools?: Array<{ tool: string; args: string; endMs: number }>
    }
  | { type: 'closed'; sessionId: string }

/** Token/context usage of a session, as returned by the RPC get_session_stats command. */
export interface SessionStats {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
}

/** A slash command the session can run via prompt, from the RPC get_commands command. */
export interface SlashCommand {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
}

/** Answer to an extension UI dialog, sent back over the session's stdin. */
export type ExtensionUiAnswer = { cancelled: true } | { value: string } | { confirmed: boolean }

/** pi model/agent configuration, persisted in pi's own settings.json. */
export interface ModelConfig {
  defaultProvider: string
  defaultModel: string
  defaultThinkingLevel: '' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  projectTrust: 'ask' | 'always' | 'never'
  /** Providers with stored credentials in auth.json (ids only, never secrets). */
  authProviders: string[]
}

// ---------------------------------------------------------------------------
// Custom providers (~/.omp/agent/models.yml — current Oh My Pi profile only)
// ---------------------------------------------------------------------------

/** Provider API dialects the GUI exposes (omp supports more; these cover the common cases). */
export type CustomProviderApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/** One manually-declared model of a custom provider. */
export interface CustomProviderModelSpec {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
}

/** Write spec for a custom provider (renderer → main, sanitized + revalidated in main). */
export interface CustomProviderSpec {
  id: string
  baseUrl: string
  api: CustomProviderApi
  /** New API key. Omitted when editing keeps the key already in models.yml. */
  apiKey?: string
  /** No-key local server (models.yml `auth: none`). */
  authNone: boolean
  /** Auto-discover models via GET <baseUrl>/models; mutually exclusive with models. */
  discovery: boolean
  models: CustomProviderModelSpec[]
}

/**
 * A custom provider as listed to the renderer. NEVER carries key material —
 * `hasKey` is all the UI gets to know.
 */
export interface CustomProviderInfo {
  id: string
  baseUrl: string
  api: string
  hasKey: boolean
  authNone: boolean
  discovery: boolean
  /** Manual models with full detail, so the edit form can round-trip them. */
  models: { id: string; name: string; contextWindow?: number; maxTokens?: number }[]
  source: 'custom'
}

export type CustomProvidersListResult =
  | { ok: true; providers: CustomProviderInfo[] }
  | { ok: false; error: 'parse' | 'read'; detail?: string }

export type CustomProviderError =
  | 'invalid-spec'
  | 'invalid-id'
  | 'invalid-base-url'
  | 'invalid-api'
  | 'invalid-api-key'
  | 'invalid-models'
  | 'parse'
  | 'read'
  | 'write-failed'
  | 'verify-failed'

export type CustomProviderSaveResult =
  | { ok: true; verified: boolean }
  | { ok: false; error: CustomProviderError; detail?: string }

export type CustomProviderDeleteResult = { ok: boolean; error?: 'parse' | 'read' | 'write-failed' }

/**
 * A model pi can actually use (credentials present), as returned by the RPC
 * `get_available_models` command — only the fields the GUI needs.
 */
export interface PiModel {
  id: string
  name: string
  provider: string
  reasoning: boolean
}

/** API-key providers pi supports (providers.md), shown in Settings. */
export const PI_PROVIDERS: { id: string; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google Gemini' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'kimi-coding', label: 'Kimi For Coding' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'minimax-cn', label: 'MiniMax (China)' },
  { id: 'zai', label: 'ZAI Coding Plan' },
  { id: 'zai-coding-cn', label: 'ZAI Coding (China)' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'xai', label: 'xAI' },
  { id: 'groq', label: 'Groq' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'cerebras', label: 'Cerebras' },
  { id: 'nvidia', label: 'NVIDIA NIM' },
  { id: 'together', label: 'Together AI' },
  { id: 'fireworks', label: 'Fireworks' },
  { id: 'huggingface', label: 'Hugging Face' },
  { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway' },
  { id: 'azure-openai-responses', label: 'Azure OpenAI' },
  { id: 'opencode', label: 'OpenCode Zen' },
  { id: 'opencode-go', label: 'OpenCode Go' },
  { id: 'ant-ling', label: 'Ant Ling' },
  { id: 'xiaomi', label: 'Xiaomi MiMo' },
  { id: 'cloudflare-ai-gateway', label: 'Cloudflare AI Gateway' },
  { id: 'cloudflare-workers-ai', label: 'Cloudflare Workers AI' }
]

/**
 * Session RPC thinking levels — the enum of `set_thinking_level` /
 * `--thinking`. A live session may be set to `off`. This is a *session
 * runtime state*, never the global default.
 */
export type SessionThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Ordered session levels (least to most intensive). */
export const SESSION_THINKING_LEVELS: readonly SessionThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/**
 * Config `defaultThinkingLevel` enum, verified against current Oh My Pi
 * 17.2.12 (`omp config set defaultThinkingLevel`): `auto` is valid and `off`
 * is NOT — the default is a reasoning-depth setting, not an on/off switch.
 * Exact accepted set: minimal, low, medium, high, xhigh, max, auto.
 */
export type DefaultThinkingLevel = 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Ordered config default levels (auto first, then least to most intensive). */
export const DEFAULT_THINKING_LEVELS: readonly DefaultThinkingLevel[] = [
  'auto',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

// ---------------------------------------------------------------------------
// Runtime settings / auth / models (normalized; never upstream-internal schema)
// ---------------------------------------------------------------------------

/** Which runtime family the detected CLI belongs to. */
export type RuntimeProfile = 'current' | 'legacy'

export type CapabilityState = 'supported' | 'unsupported' | 'unknown'

/**
 * A login provider as the settings overview reports it: identity from the
 * CLI registry (`omp auth-broker list`), `authenticated` layered on from the
 * RPC probe (or the credential-filtered `omp models --json` fallback).
 */
export interface RuntimeProvider {
  id: string
  name: string
  available: boolean
  authenticated: boolean
}

/** A model as the runtime catalogs it (credential-filtered availability). */
export interface RuntimeModelInfo {
  provider: string
  id: string
  /** provider/id — the form config and set_model take. */
  selector: string
  name: string
  contextWindow?: number
  maxTokens?: number
  reasoning: boolean
  /** Per-model supported thinking levels (off is universal); empty = unknown. */
  thinking: string[]
  /** Provider endpoint metadata (catalog only) — used for live key checks. */
  baseUrl?: string
  api?: string
}

/** Runtime-resolved default model/thinking state (new sessions). */
export interface RuntimeModelState {
  /**
   * Default model selector, read from `modelRoles.default` (never
   * `enabledModels[0]`). '' = runtime automatic resolution.
   */
  defaultModel: string
  /** True when `modelRoles.default` is explicitly set; false = automatic. */
  defaultModelExplicit: boolean
  defaultThinkingLevel: string
}

export interface RuntimeCapabilities {
  providers: CapabilityState
  nativeLogin: CapabilityState
  logout: CapabilityState
  modelCatalog: CapabilityState
  defaultModelConfig: CapabilityState
  defaultThinkingConfig: CapabilityState
  machineSkillsConfig: CapabilityState
}

/**
 * Runtime-reported machine-skills toggle state. `unknown` covers a missing /
 * non-boolean read-back; it must never render as an explicit ON toggle.
 */
export type MachineSkillsState = 'enabled' | 'disabled' | 'unknown'

/** Settings-page overview: everything is runtime-reported, nothing assumed. */
export interface RuntimeOverview {
  profile: RuntimeProfile
  capabilities: RuntimeCapabilities
  providers: RuntimeProvider[]
  modelState: RuntimeModelState
  /**
   * `skills.enableAgentsUser` read-back as a truth value. Capability
   * (whether this OMP version exposes the key at all) lives separately in
   * `capabilities.machineSkillsConfig`.
   */
  machineSkillsState: MachineSkillsState
}

/**
 * Login flow state machine. Interactive prompts arrive as part of the state
 * (input/select/confirm); the renderer answers them via auth:answerLogin.
 */
export type LoginState =
  | { status: 'idle' }
  | { status: 'starting'; providerId: string }
  | {
      status: 'waiting_for_browser'
      providerId: string
      instructions?: string
      /** The URL the runtime asked to open (never auto-opened — user-initiated). */
      url?: string
      launchUrl?: string
    }
  | {
      status: 'waiting_for_input'
      providerId: string
      requestId: string
      title: string
      placeholder?: string
      timeoutMs?: number
    }
  | {
      status: 'waiting_for_select'
      providerId: string
      requestId: string
      title: string
      options: string[]
      timeoutMs?: number
    }
  | {
      status: 'waiting_for_confirm'
      providerId: string
      requestId: string
      title: string
      message?: string
      timeoutMs?: number
    }
  | { status: 'verifying'; providerId: string; message?: string }
  | { status: 'connected'; providerId: string }
  | { status: 'failed'; providerId: string; message: string }
  | { status: 'cancelled'; providerId: string }

/** Answer to a login prompt (mirrors the extension UI answer shapes). */
export type LoginAnswer = { value: string } | { confirmed: boolean } | { cancelled: true }

/** An image attached to a prompt/steer/follow_up RPC command. */
export interface PromptImage {
  type: 'image'
  /** base64-encoded image bytes */
  data: string
  mimeType: string
}

/**
 * Result of the image picker dialog: the image bytes as base64, or a
 * categorized failure. `null` means the user cancelled the dialog.
 */
export type SelectImageResult =
  | { ok: true; name: string; data: string; mimeType: string }
  | { ok: false; error: 'tooLarge' | 'notImage' | 'readFailed' }
  | null

/** How a prompt sent mid-stream is queued by pi. */
export type StreamingBehavior = 'steer' | 'followUp'

/**
 * A chat message as rendered by the GUI. Mirrors the renderer's MessageLike;
 * defined here so the main process can rebuild transcripts for resumed sessions.
 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** system messages only: 'info' renders neutral instead of the error style. */
  variant?: 'info'
  /** Thinking text of an assistant message (collapsible block in the UI). */
  thinking?: string
  /** Per-turn runtime model selector (`provider/id`) this user turn dispatched under. */
  runtimeModel?: string
  /** Per-turn session thinking level at dispatch. */
  runtimeThinking?: string
  /** Interaction kind of a user message: a steered message, or a normal prompt. */
  kind?: 'prompt' | 'steer'
  toolCall?: {
    tool: string
    input: unknown
    output?: unknown
    isError?: boolean
  }
}

/**
 * A persisted session exposed to the renderer through a Main-owned capability.
 *
 * `id` is opaque and bound to the requesting renderer plus its workspace
 * grant. Durable session-file paths and header cwd values intentionally never
 * cross this boundary.
 */
export interface HistorySessionDescriptor {
  /** Opaque Main-issued capability id for resume/delete operations. */
  id: string
  /** Session uuid from the file header, for display/deduplication only. */
  uuid: string
  /** First user message, truncated to 80 chars; 'Untitled' when absent. */
  title: string
  /** Session start time, epoch ms. */
  timestamp: number
}

/**
 * Legacy three-tier tool access, still used by the current renderer UI.
 * Subset of PermissionMode — mirrored into it on write (see ipc.ts).
 */
export type ToolAccess = 'full' | 'no-bash' | 'readonly'

/**
 * Permission mode applied when a session is created:
 * 'full'/'no-bash'/'readonly' map to --exclude-tools; 'ask' leaves every tool
 * enabled and gates each call through the bundled approval extension.
 */
export type PermissionMode = 'full' | 'no-bash' | 'readonly' | 'ask'

/** Plugin source flavor. Legacy Pi derives this from settings.json; current OMP reports it natively. */
export type PackageSourceKind = 'npm' | 'git' | 'local' | 'marketplace'

/** The CLI profile that owns the plugin surface currently shown in the GUI. */
export type PackageManagerProfile = 'current' | 'legacy' | 'unavailable'

/** Native plugin operations that are actually available for the detected CLI. */
export interface PackageManagerCapabilities {
  profile: PackageManagerProfile
  /** Current OMP exposes native enable/disable commands for the active CLI. */
  canToggle: boolean
  /** Current OMP exposes native marketplace upgrades for the active CLI. */
  canUpdate: boolean
}

export type PackageScope = 'user' | 'project'

export interface PackageResource {
  type: 'extension' | 'skill' | 'prompt' | 'theme'
  name: string
}

export interface PackageInfo {
  /** Stable GUI row id. Legacy Pi uses its settings.json source verbatim. */
  source: string
  /** Native CLI target when the stable GUI row id is profile/scope-qualified. */
  commandSource?: string
  /** Current OMP marketplace install scope, when relevant. */
  scope?: PackageScope
  kind: PackageSourceKind
  name: string
  description?: string
  version?: string
  enabled: boolean
  /** Resolved install location (dir or single file); undefined if not found on disk. */
  path?: string
  resources: PackageResource[]
  /** Versioned npm specs and git refs are pinned; `pi update` skips them. */
  pinned: boolean
  /** Whether this individual plugin has a real update action in its owning CLI. */
  canUpdate?: boolean
}

/**
 * A package row exposed to the renderer through a short-lived Main-owned
 * capability. The id is the only valid input for a row mutation. Command
 * targets, install paths and scopes stay in Main because they can contain
 * private filesystem locations or credential-bearing URLs.
 */
export interface PackageDescriptor {
  /** Opaque, renderer-bound capability for one listed package row. */
  id: string
  kind: PackageSourceKind
  name: string
  description?: string
  version?: string
  enabled: boolean
  resources: PackageResource[]
  pinned: boolean
  /** Whether Main reports a real update operation for this row. */
  canUpdate?: boolean
  /**
   * A deliberately sanitized marketplace identity (for example
   * `npm:pkg` or `github:owner/repo`) used only to display an Installed
   * badge. It is never a CLI argument or a filesystem path.
   */
  marketplaceKey?: string
}

/**
 * One short-lived, Main-held local source selected for package installation.
 * The renderer sees a display label only; the canonical source remains in
 * Main until the user confirms installation through a native dialog.
 */
export interface PackageLocalSourceGrant {
  id: string
  purpose: 'package-local-install'
  name: string
  kind: 'file' | 'directory'
  createdAt: number
}

export interface PackageActionResult {
  ok: boolean
  log: string
}

// ---------------------------------------------------------------------------
// Kimi Computer Use bridge — Kimi CU stays a separate, user-installed local
// runtime. These are deliberately status/configuration records only: raw
// executable paths, MCP traffic and desktop screenshots never cross preload.
// ---------------------------------------------------------------------------

export type KimiComputerUseReadiness =
  | 'ready'
  | 'not-installed'
  | 'unsupported-platform'
  | 'service-unavailable'
  | 'permission-required'
  | 'bridge-unreachable'
  | 'configuration-error'

export interface KimiComputerUseStatus {
  readiness: KimiComputerUseReadiness
  /** Kimi CU app bundle exists and is executable on this machine. */
  installed: boolean
  /** Its background XPC service answered the official status probe. */
  serviceRunning: boolean
  accessibilityGranted: boolean
  screenRecordingGranted: boolean
  /** OMP GUI's explicitly managed MCP registration is present and enabled. */
  configured: boolean
  /** A short-lived, read-only MCP initialize/tools-list probe succeeded. */
  bridgeReachable: boolean
  /** Number of MCP tools reported by the local runtime; no schemas leave Main. */
  toolCount: number
  version?: string
  /** Bounded, non-sensitive diagnostic appropriate for the renderer. */
  detail?: string
  /** Official documentation/install page; users install Kimi CU themselves. */
  downloadUrl: string
}

export interface KimiComputerUseMutationResult {
  ok: boolean
  status: KimiComputerUseStatus
  error?: string
}

// ---------------------------------------------------------------------------
// OMP GUI-managed handwritten plugins. The source tree lives under userData
// and only its opaque id/metadata/code cross preload; a renderer never chooses
// a filesystem path or invokes a runtime command directly.
// ---------------------------------------------------------------------------

export interface ManagedPluginDraft {
  id?: string
  name: string
  displayName?: string
  description: string
  version: string
  /** Contents of the generated package's extensions/index.ts file. */
  code: string
}

export interface ManagedPluginDescriptor {
  id: string
  name: string
  displayName?: string
  description: string
  version: string
  createdAt: number
  updatedAt: number
  /** The most recent successful OMP link/sync time, if any. */
  syncedAt?: number
  /** Bounded, redacted runtime error from the latest sync attempt. */
  lastSyncError?: string
}

export interface ManagedPluginDetail extends ManagedPluginDescriptor {
  code: string
}

export type ManagedPluginSaveResult =
  | { ok: true; plugin: ManagedPluginDetail }
  | { ok: false; error: string }

export type ManagedPluginActionResult =
  | { ok: true; plugin?: ManagedPluginDescriptor; log: string }
  | { ok: false; error: string; log: string }

/** Category buckets used by the curated marketplace list. */
export type CuratedPackageCategory = 'web' | 'mcp' | 'agents' | 'quality' | 'safety' | 'productivity'

/** A hand-picked GitHub-hosted pi package featured in the marketplace. */
export interface CuratedPackageInfo {
  name: string
  /** GitHub `owner/repo`; installed via `git:github.com/<repo>`. */
  repo: string
  description: string
  category: CuratedPackageCategory
}

/** A pi package found on the npm registry (community/curated lists). */
export interface CommunityPackageInfo {
  name: string
  description: string
  version: string
  /** GitHub `owner/repo` when the package installs from git instead of npm. */
  repo?: string
  category?: CuratedPackageCategory
}

/** Extension skeleton offered by the plugin scaffold form. */
export type PluginTemplate = 'blank' | 'command' | 'tool-guard'

/** Main-internal scaffold spec after a DirectoryGrant has been resolved. */
export interface PluginScaffoldSpec {
  name: string
  displayName?: string
  description: string
  version: string
  author?: string
  /** Existing parent directory; the package is created in <parentDir>/<name>. */
  parentDir: string
  extension: boolean
  skill: boolean
  prompt: boolean
  template: PluginTemplate
}

/**
 * Renderer-facing plugin scaffold request. Unlike PluginScaffoldSpec it never
 * carries a filesystem path: Main resolves parentGrantId to the selected
 * directory after validation.
 */
export interface PluginScaffoldRequest {
  name: string
  displayName?: string
  description: string
  version: string
  author?: string
  parentGrantId: string
  extension: boolean
  skill: boolean
  prompt: boolean
  template: PluginTemplate
}

/** Stable error codes from plugin scaffolding; the renderer maps them to i18n. */
export type PluginScaffoldError =
  | 'invalid-spec'
  | 'invalid-grant'
  | 'invalid-name'
  | 'invalid-version'
  | 'no-resources'
  | 'dir-missing'
  | 'unsafe-path'
  | 'dir-not-empty'
  | 'write-failed'

/**
 * Opaque Main-held handle for the directory produced by a successful
 * scaffold. Its canonical path never crosses into the renderer; install and
 * reveal each take this id and resolve it in Main.
 */
export interface PluginScaffoldOutput {
  id: string
  name: string
  createdAt: number
}

/** Main-internal filesystem result; not exposed over preload. */
export type PluginScaffoldInternalResult =
  | { ok: true; dir: string; files: string[] }
  | { ok: false; error: PluginScaffoldError; detail?: string }

/** Renderer-facing result — deliberately contains no absolute path. */
export type PluginScaffoldResult =
  | { ok: true; output: PluginScaffoldOutput; files: string[] }
  | { ok: false; error: PluginScaffoldError; detail?: string }

// ---------------------------------------------------------------------------
// Kanban boards v2 — local-only widget-grid dashboards, persisted under
// userData/kanban-boards.json (v1 column/card files are migrated on read,
// see migrateBoard in shared/boards.ts).
// ---------------------------------------------------------------------------

export type WidgetType =
  | 'clock'
  | 'note'
  | 'counter'
  | 'gauge'
  | 'chart-line'
  | 'chart-bar'
  | 'todo'
  | 'link'

export interface BoardWidgetLayout {
  /** Grid units on a 12-column grid: x 0-11, w 1-12 (x + w ≤ 12), h 1-20, y ≥ 0. */
  x: number
  y: number
  w: number
  h: number
}

/**
 * Deliberately bounded visual controls for a widget. They provide a rich
 * appearance surface without persisting arbitrary CSS (which would make the
 * local board file an unsafe renderer input).
 */
export interface BoardWidgetStyle {
  /** Six-digit hex colors selected in the appearance panel. */
  accent?: string
  surface?: string
  text?: string
  border?: string
  /** Pixel values, clamped by shared board validation. */
  radius?: number
  padding?: number
  titleAlign?: 'left' | 'center' | 'right'
  shadow?: 'none' | 'soft' | 'strong'
}

/** Canvas-level appearance, shared by all widgets on a board. */
export interface BoardStyle {
  background?: string
  grid?: 'none' | 'dots' | 'lines'
}

export interface BoardWidget {
  id: string
  type: WidgetType
  title: string
  layout: BoardWidgetLayout
  /** Type-specific settings, whitelisted per widget type (see shared/boards). */
  config: Record<string, unknown>
  /** Optional bounded appearance overrides; see BoardWidgetStyle. */
  style?: BoardWidgetStyle
}

export interface KanbanBoard {
  id: string
  name: string
  description?: string
  widgets: BoardWidget[]
  /** Optional canvas appearance, stored separately from widget data. */
  style?: BoardStyle
  createdAt: number
  updatedAt: number
}

/** Narrow chat → board mutation: Main appends one note to the latest board. */
export interface BoardNoteAppendRequest {
  boardId: string
  title: string
  text: string
}

export type BoardNoteAppendResult =
  | { ok: true; board: KanbanBoard }
  | {
      ok: false
      error: 'invalid-request' | 'not-found' | 'board-full' | 'board-store-unreadable' | 'write-failed'
    }

// ---------------------------------------------------------------------------
// Board datasets — imported ad-backend CSV/XLSX exports that counter/chart
// widgets can bind to. Persisted under userData/board-datasets.json; parsing
// and aggregation live in shared/datasets.ts.
// ---------------------------------------------------------------------------

export interface BoardDatasetColumn {
  name: string
  type: 'number' | 'date' | 'text'
}

export interface BoardDataset {
  id: string
  name: string
  columns: BoardDatasetColumn[]
  /** Parsed values; number columns hold numbers, everything else strings. */
  rows: (string | number)[][]
  createdAt: number
}

export type Language = 'zh' | 'en'

export interface AppSettings {
  theme: 'dark' | 'light'
  language: Language
  windowWidth: number
  windowHeight: number
  recentProjects: string[]
  setupComplete: boolean
  /** Legacy three-tier setting kept for the current renderer UI. */
  toolAccess: ToolAccess
  /** Effective per-session permission mode; supersedes toolAccess. */
  permissionMode: PermissionMode
  /** Load machine-local ~/.agents/skills into sessions (default off — they belong to other agents). */
  machineSkills: boolean
  /** Desktop notification when an agent turn finishes while the window is unfocused. */
  notifications: boolean
  /** Show a preview of the assistant response in turn-finished notifications. */
  notificationPreviews: boolean
  /** Sidebar: sessions pinned to the top of the list. */
  pinnedSessionIds: string[]
  /** Sidebar: sessions folded away into the archived group. */
  archivedSessionIds: string[]
}

export type InstallStatus =
  | { type: 'idle' }
  | { type: 'downloading'; progress: number; message: string }
  | { type: 'installing'; message: string }
  | { type: 'success' }
  | { type: 'error'; message: string }

export type ReadFileResult =
  | { ok: true; content: string }
  | { ok: false; error: string }

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  language: 'en',
  windowWidth: 1280,
  windowHeight: 800,
  recentProjects: [],
  setupComplete: false,
  toolAccess: 'full',
  permissionMode: 'ask',
  machineSkills: false,
  notifications: true,
  notificationPreviews: false,
  pinnedSessionIds: [],
  archivedSessionIds: []
}

/** Snapshot of a live session, from the RPC get_state command. */
export interface SessionState {
  isStreaming: boolean
  isCompacting: boolean
  pendingMessageCount: number
  sessionId: string
  sessionName?: string
  /** pi's on-disk session JSONL path. */
  sessionFile?: string
  messageCount: number
  thinkingLevel: string
  model?: unknown
  autoCompactionEnabled?: boolean
}

/** A git snapshot of the project worktree, taken before an agent turn. */
export interface CheckpointInfo {
  id: string
  sessionId: string
  /** Dangling commit sha holding the full tree (never referenced by a branch). */
  sha: string
  /** Untracked files present at checkpoint time (restore keeps these). */
  untracked: string[]
  promptPreview: string
  /** Index of the user message this checkpoint precedes. */
  msgIndex: number
  createdAt: number
}

export interface GitFileChange {
  path: string
  status: 'M' | 'A' | 'D' | 'untracked'
  /** null for binary files and untracked entries */
  additions: number | null
  deletions: number | null
}

export interface GitInfo {
  branch: string
  files: GitFileChange[]
  totalAdditions: number
  totalDeletions: number
}

/** Auto-update state machine, broadcast to the renderer on every change. */
export type UpdaterStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  /** A check completed and found nothing newer. */
  | { status: 'none' }
  | { status: 'available'; version: string }
  | { status: 'downloading' }
  | { status: 'progress'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }
  /** Dev builds have no updater; returned by updaterCheck only. */
  | { status: 'dev' }
