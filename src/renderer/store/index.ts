import { create } from 'zustand'
import { Session, SessionEvent, SessionRuntimeState, SessionStats, PackageDescriptor, InstallStatus, Language, ModelConfig, PermissionMode, PiModel, PromptImage, RuntimeOverview, RuntimeModelInfo, LoginState, LoginAnswer, SessionThinkingLevel, HistoricalAgentRecord, WorkspaceGrant, RecentWorkspaceDescriptor } from '@shared/types'
import { applyToolResult, ToolCallRecord } from '../lib/toolCalls'
import { captureSessionSnapshot } from '../lib/runtimeSnapshot'
import { emptyProjection, foldExecutionEvent, ExecutionProjection, applyAgentRoster, foldUserSteer, applyHistoricalAgents } from '../lib/execution'
import { SessionRecord, removeHistoryRecord, removeLiveSessionRecords, replaceHistoricalSessionRecords, updateSessionRecordFile, updateSessionRecordTitle, upsertLiveSessionRecord } from '../lib/sessionRegistry'
import { clearComposerDraft, ComposerDrafts, pruneComposerDrafts, SessionComposerDraft, setComposerDraft } from '../lib/composerDraft'
import type { I18nKey } from '../i18n'

export interface MessageLike {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /**
   * Interaction kind of a user-originated message. `steer` marks a message
   * steered into the CURRENT active turn (not a new prompt turn); `prompt`
   * (or undefined) is a normal new user turn. Assistant/system messages leave
   * this unset.
   */
  kind?: 'prompt' | 'steer'
  /** system messages only: 'info' renders neutral instead of the error style. */
  variant?: 'info'
  /** Assistant thinking text, streamed via thinking deltas (collapsible block). */
  thinking?: string
  /** First thinking delta of this message; elapsed time renders from these. */
  thinkingStartTs?: number
  /** Thinking end (first text delta / tool call / turn end); unset while streaming. */
  thinkingEndTs?: number
  /** Images the user attached to this message (in-memory only, dataURL-grade). */
  images?: { data: string; mimeType: string }[]
  toolCall?: ToolCallRecord
  /**
   * Per-turn runtime snapshot: the actual `provider/id` model selector the
   * session was using when this user turn was dispatched. Historical turns
   * are self-describing — never re-derived from the session's current state.
   */
  runtimeModel?: string
  /** Per-turn runtime snapshot: session thinking level at dispatch. */
  runtimeThinking?: string
  /** User prompt that could not be delivered (dead session); renders a badge. */
  failed?: boolean
}

/** Verb buckets / turn-progress shapes now live in `../lib/execution` (single source). */


/**
 * Session status → busy mapping. 'waiting_for_user'/'aborting' keep the turn
 * open, so they stay busy; statuses missing from the map leave busy untouched,
 * so a newer main-process state can't wedge the renderer into a wrong one.
 */
const STATUS_BUSY: Partial<Record<SessionRuntimeState, boolean>> = {
  working: true,
  waiting_for_user: true,
  aborting: true,
  idle: false,
  failed: false
}

/**
 * App and Settings can both refresh the runtime overview. Only the most
 * recently-started request may update the singleton store: otherwise an older
 * automatic-default response can arrive last and overwrite a newer model
 * configuration response.
 */
let runtimeOverviewRequestGeneration = 0

/** A message parked while the session is busy; drained FIFO on idle. */
export interface QueuedMessage {
  id: string
  text: string
  images?: PromptImage[]
}

/** A pending interactive extension dialog, keyed by session. */
export type UiRequest = Extract<SessionEvent, { type: 'ui_request' }>

interface AppState {
  theme: 'dark' | 'light'
  language: Language
  /** Default permission mode for new sessions (persisted in electron-store). */
  permissionMode: PermissionMode
  /** Main-owned workspace grant for the current project; UI paths come from grant.displayPath. */
  currentWorkspace: WorkspaceGrant | null
  sessions: Session[]
  currentSessionId: string | null
  messages: Record<string, MessageLike[]>
  /**
   * sessionId -> the normalized execution projection (Agent Hub tree, tool
   * counts, trajectory ledger). ONE fold of the session event stream, from
   * which the Agent Hub and trajectory surfaces derive — never copied per UI.
   */
  executions: Record<string, ExecutionProjection>
  /** sessionId -> pending extension UI dialogs (FIFO) */
  uiRequests: Record<string, UiRequest[]>
  packages: PackageDescriptor[]
  rightPanelOpen: boolean
  activeRightTab: 'files' | 'preview' | 'changes'
  selectedFile: string | null
  previewContent: string | null
  /** sessionId -> checkpoint creation failed once (non-git project); skip further attempts. */
  checkpointUnavailable: Record<string, boolean>
  /** Bumped after a rollback so git views (changes tab, header chip) refetch. */
  gitInfoVersion: number
  cliAvailable: boolean | null
  /** null = not yet loaded from disk */
  setupComplete: boolean | null
  installStatus: InstallStatus
  /** Models pi can use right now (credentialed providers); empty until loaded */
  models: PiModel[]
  /** pi's own model configuration; null until loaded */
  modelConfig: ModelConfig | null
  /** sessionId -> whether the agent is currently generating */
  busy: Record<string, boolean>
  /** sessionId -> messages queued while the session is busy (FIFO) */
  queuedMessages: Record<string, QueuedMessage[]>
  /** sessionId -> queued ids temporarily reserved for an in-flight Steer RPC */
  steeringQueuedIds: Record<string, string[]>
  /** sessionId -> user-visible failure banner key (dead session / send failure). */
  sessionErrors: Record<string, I18nKey | undefined>
  /** sessionId -> whether context compaction is running */
  compacting: Record<string, boolean>
  /** sessionId -> latest known token/context usage */
  stats: Record<string, SessionStats>
  /** Sidebar: pinned sessions, listed first (persisted in electron-store). */
  pinnedSessionIds: string[]
  /** Unified live + historical session projection used by Sidebar. */
  sessionRecords: SessionRecord[]
  /** Sidebar: archived sessions, folded into the archive group (persisted). */
  archivedSessionIds: string[]
  /** sessionId -> finished a turn while not selected; cleared on select. In-memory only. */
  unreadSessionIds: Record<string, boolean>
  /** One-shot composer prefill (e.g. "build your own plugin" from the packages page). */
  composerPrefill: string | null
  /** Unsent composer text/images keyed by their owning runtime session. */
  composerDrafts: ComposerDrafts
  /** Sidebar: recent project folders, MRU first (persisted in electron-store). */
  recentProjects: string[]
  /** Main-issued descriptors used to activate recent workspaces by opaque id. */
  recentWorkspaces: RecentWorkspaceDescriptor[]
  /** True while the history list is being (re)loaded; entries may be stale. */
  historyLoading: boolean
  /** Runtime-reported settings overview (profile/capabilities/providers/defaults). */
  runtimeOverview: RuntimeOverview | null
  /** Runtime model catalog (current profile; legacy rides `models`). */
  runtimeModels: RuntimeModelInfo[]
  /** Full static model catalog (credential-independent) for the Settings picker. */
  runtimeModelCatalog: RuntimeModelInfo[]
  /** sessionId -> runtime-resolved thinking level (thinking_level_changed events). */
  sessionThinking: Record<string, string | undefined>
  /** sessionId -> bumped on model_changed; pickers refetch get_state. */
  sessionModelVersion: Record<string, number>
  /** Native login flow state (idle when no flow runs). */
  loginState: LoginState
  setTheme: (theme: 'dark' | 'light') => void
  setLanguage: (language: Language) => void
  /** Set the default permission mode for new sessions and persist it. */
  setPermissionMode: (mode: PermissionMode) => void
  /** Replace the active workspace grant (and sync the MRU real paths). */
  setCurrentWorkspace: (grant: WorkspaceGrant | null) => void
  /** Activate a Main-listed recent workspace by opaque id. */
  activateRecentWorkspace: (recentId: string) => Promise<void>
  /** Show the native folder dialog and select the resulting grant. */
  selectWorkspace: () => Promise<void>
  setSessions: (sessions: Session[]) => void
  /** Merge Main's live registry without clobbering a session created concurrently. */
  registerSessions: (sessions: Session[]) => void
  addSession: (session: Session, select?: boolean) => void
  setCurrentSessionId: (id: string | null) => void
  /** Hydrate the subagent roster for a session from `get_subagents` (live merge). */
  hydrateSubagents: (sessionId: string) => Promise<void>
  /** Fold durable historical agents (reconstructed on resume) into the projection. */
  applyHistoricalAgents: (sessionId: string, records: HistoricalAgentRecord[]) => void
  /** Record a steer interaction inside the ACTIVE turn's trajectory. */
  recordSteer: (sessionId: string, text: string) => void
  addMessage: (sessionId: string, message: MessageLike) => void
  /** Patch one message in place (failed flag, late runtime-snapshot tags). */
  updateMessage: (sessionId: string, messageId: string, patch: Partial<MessageLike>) => void
  /** Replace a session's whole transcript (history resume backfill). */
  setMessages: (sessionId: string, messages: MessageLike[]) => void
  appendMessageContent: (sessionId: string, content: string) => void
  /** Append a thinking delta to the in-flight assistant message. */
  appendThinking: (sessionId: string, delta: string) => void
  /** Stamp thinkingEndTs on the session's last message if its thinking is open. */
  finalizeThinking: (sessionId: string) => void
  resolveUiRequest: (sessionId: string, requestId: string) => void
  setPackages: (packages: PackageDescriptor[]) => void
  setRightPanelOpen: (open: boolean) => void
  setActiveRightTab: (tab: 'files' | 'preview' | 'changes') => void
  setSelectedFile: (path: string | null) => void
  setPreviewContent: (content: string | null) => void
  setCheckpointUnavailable: (sessionId: string, unavailable: boolean) => void
  bumpGitInfoVersion: () => void
  /**
   * Snapshot the project after a user message was accepted by the session.
   * No-op for sessions already known to live outside a git repo; the first
   * null result marks the session unavailable so later messages skip the IPC.
   */
  createCheckpointForMessage: (sessionId: string, msgIndex: number, text: string) => Promise<void>
  setCliAvailable: (available: boolean) => void
  setBusy: (sessionId: string, busy: boolean) => void
  /** Set/clear a session's user-visible failure banner (i18n key). */
  setSessionError: (sessionId: string, key: I18nKey | null) => void
  /** Clear a recoverable error only when it is still the expected key. */
  clearSessionErrorIf: (sessionId: string, key: I18nKey) => void
  /** Append a message to the session's queue. */
  enqueueQueuedMessage: (sessionId: string, message: QueuedMessage) => void
  /** Remove one queued message by id. */
  removeQueuedMessage: (sessionId: string, id: string) => void
  /** Pop the first queued message (returns it, or undefined when empty). */
  shiftQueuedMessage: (sessionId: string) => QueuedMessage | undefined
  /** Reserve one queued message without changing FIFO ownership. */
  reserveQueuedMessage: (sessionId: string, id: string) => boolean
  /** Release a queued-message Steer reservation after ACK failure. */
  releaseQueuedMessage: (sessionId: string, id: string) => void
  /** Drain one queued message when the runtime is idle. */
  drainQueuedMessage: (sessionId: string) => boolean
  /** Drop every queued message of a session. */
  clearQueuedMessages: (sessionId: string) => void
  setCompacting: (sessionId: string, compacting: boolean) => void
  setStats: (sessionId: string, stats: SessionStats) => void
  /** Replace the pinned list (startup load; does not persist). */
  setPinnedSessionIds: (ids: string[]) => void
  /** Toggle a session's pin and persist the new list. */
  togglePinSession: (sessionId: string) => void
  /** Replace the archived list (startup load; does not persist). */
  setArchivedSessionIds: (ids: string[]) => void
  /** Archive/unarchive a session and persist the new list. */
  setSessionArchived: (sessionId: string, archived: boolean) => void
  markSessionUnread: (sessionId: string) => void
  setComposerPrefill: (text: string | null) => void
  setComposerDraft: (sessionId: string, draft: SessionComposerDraft) => void
  clearComposerDraft: (sessionId: string) => void
  /** Replace the recent-projects list (startup load; does not persist). */
  setRecentProjects: (paths: string[]) => void
  /** Replace Main-issued recent workspace descriptors (startup load). */
  setRecentWorkspaces: (workspaces: RecentWorkspaceDescriptor[]) => void
  /** Drop one path from the recent-projects list and persist the new list. */
  removeRecentProject: (path: string) => void
  /** (Re)load the persisted session history of the current workspace; null clears the list. */
  loadHistorySessions: (grantId: string | null) => Promise<void>
  /** Drop one entry from the history list (after its opaque capability was deleted). */
  removeHistorySession: (historyId: string) => void
  /** Update one session's display title in place. */
  setSessionTitle: (sessionId: string, title: string) => void
  setSessionFile: (sessionId: string, sessionFile: string) => void
  /**
   * Auto-name a session from its first user message when it still carries the
   * default title (project dir basename). No-op once the session has a real
   * name or more than one user message.
   */
  maybeNameSession: (sessionId: string, text: string) => Promise<void>
  setSetupComplete: (complete: boolean) => void
  setInstallStatus: (status: InstallStatus) => void
  /** (Re)load model config + available models from the main process. */
  loadModelState: () => Promise<void>
  /**
   * Hot-switch the CURRENT session's model — session scope only. Never
   * touches the default for future sessions (that lives in Settings).
   */
  setCurrentSessionModel: (provider: string, modelId: string) => Promise<boolean>
  /** Hot-switch the CURRENT session's thinking level — session scope only. */
  setCurrentSessionThinking: (level: SessionThinkingLevel) => Promise<boolean>
  /** Model selector for the NEXT session's spawn args (''/null = runtime default). */
  pendingModel: string | null
  /** Thinking level for the NEXT session's spawn args (null = runtime default). */
  pendingThinking: SessionThinkingLevel | null
  /** Set the next-session model override (composer pickers without a session). */
  setPendingModel: (selector: string | null) => void
  /** Set the next-session thinking override. */
  setPendingThinking: (level: SessionThinkingLevel | null) => void
  /** Snapshot next-session spawn overrides without consuming the user's choice. */
  getSessionOverrides: () => { modelSelector?: string; thinkingLevel?: SessionThinkingLevel }
  /**
   * Clear only overrides that still match a successful session's snapshot.
   * A picker change made while creation is in flight belongs to the next
   * session and must remain selected.
   */
  clearSessionOverrides: (overrides: {
    modelSelector?: string
    thinkingLevel?: SessionThinkingLevel
  }) => void
  /** Refresh the runtime settings overview (profile/capabilities/providers). */
  loadRuntimeOverview: (force?: boolean) => Promise<void>
  /** Refresh the runtime model catalog (current profile). */
  loadRuntimeModels: () => Promise<void>
  /** Refresh the full static model catalog (Settings picker). */
  loadRuntimeModelCatalog: () => Promise<void>
  /** Persist the runtime default model (current profile; '' = runtime default). */
  selectRuntimeDefaultModel: (selector: string) => Promise<{ ok: boolean; error?: string }>
  /** Persist the runtime default thinking level (current profile). */
  setRuntimeDefaultThinking: (level: string) => Promise<{ ok: boolean; error?: string }>
  /** Toggle machine skills via the runtime config (current profile). */
  setRuntimeMachineSkills: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>
  /** Set a provider's API key directly (paste-key form, provider-validated). */
  setRuntimeApiKey: (providerId: string, key: string) => Promise<{ ok: boolean; error?: string }>
  /** Start the native login flow for a provider. */
  startLogin: (providerId: string) => Promise<{ ok: boolean; error?: string }>
  /** Answer the pending login prompt. */
  answerLogin: (answer: LoginAnswer) => Promise<{ ok: boolean; error?: string }>
  /** Cancel the running login flow. */
  cancelLogin: () => Promise<{ ok: boolean; error?: string }>
  /** Open a login URL the runtime asked for (explicit user action). */
  openLoginUrl: (url: string) => Promise<{ ok: boolean; error?: string }>
  /** Remove a provider credential via the runtime. */
  logoutProvider: (providerId: string) => Promise<{ ok: boolean; error?: string }>
  applySessionEvent: (event: SessionEvent) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  theme: 'light',
  language: 'en',
  permissionMode: 'ask',
  currentWorkspace: null,
  sessions: [],
  currentSessionId: null,
  messages: {},
  executions: {},
  uiRequests: {},
  packages: [],
  rightPanelOpen: false,
  activeRightTab: 'files',
  selectedFile: null,
  previewContent: null,
  checkpointUnavailable: {},
  gitInfoVersion: 0,
  cliAvailable: null,
  setupComplete: null,
  installStatus: { type: 'idle' },
  models: [],
  modelConfig: null,
  busy: {},
  queuedMessages: {},
  steeringQueuedIds: {},
  sessionErrors: {},
  compacting: {},
  stats: {},
  pinnedSessionIds: [],
  sessionRecords: [],
  archivedSessionIds: [],
  unreadSessionIds: {},
  composerPrefill: null,
  composerDrafts: {},
  recentProjects: [],
  recentWorkspaces: [],
  historyLoading: false,
  runtimeOverview: null,
  runtimeModels: [],
  runtimeModelCatalog: [],
  sessionThinking: {},
  sessionModelVersion: {},
  loginState: { status: 'idle' },
  pendingModel: null,
  pendingThinking: null,

  setTheme: (theme) => {
    set({ theme })
    document.documentElement.classList.toggle('dark', theme === 'dark')
    window.electronAPI.setStore('theme', theme)
  },
  setLanguage: (language) => {
    set({ language })
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    window.electronAPI.setStore('language', language)
  },
  setPermissionMode: (permissionMode) => {
    set({ permissionMode })
    window.electronAPI.setStore('permissionMode', permissionMode)
  },
  setCurrentWorkspace: (grant) =>
    set((state) => {
      if (!grant) return { currentWorkspace: null, currentSessionId: null }
      // The MRU stores the grant's canonical realPath — that is what Main
      // persists for sessions (session.cwd), so display-spelling variants of
      // the same folder can't produce duplicate entries or orphan groups.
      const realPath = grant.realPath
      const recentProjects = [
        realPath,
        ...state.recentProjects.filter((p) => p !== realPath)
      ].slice(0, 10)
      // Grant ids are ephemeral. Workspace scope follows canonical realPath,
      // so re-activating the same project does not discard its current chat.
      const workspaceChanged = state.currentWorkspace?.realPath !== realPath
      return {
        currentWorkspace: grant,
        recentProjects,
        ...(workspaceChanged ? { currentSessionId: null } : {})
      }
    }),
  activateRecentWorkspace: async (recentId) => {
    const grant = await window.electronAPI.activateRecentWorkspace(recentId)
    if (grant) {
      get().setCurrentWorkspace(grant)
    } else {
      // Main revalidates and prunes stale entries. Refresh the descriptor list
      // instead of attempting to remove a renderer-supplied path locally.
      const workspaces = await window.electronAPI.listRecentWorkspaces()
      set((state) => {
        const active = state.currentWorkspace
        const isCurrent = active !== null && !workspaces.some((entry) => entry.displayPath === active.realPath)
        return {
          recentWorkspaces: workspaces,
          recentProjects: workspaces.map((entry) => entry.displayPath),
          ...(isCurrent ? { currentWorkspace: null } : {})
        }
      })
    }
  },
  selectWorkspace: async () => {
    const grant = await window.electronAPI.selectWorkspace()
    if (grant) {
      get().setCurrentWorkspace(grant)
      get().setRecentWorkspaces(await window.electronAPI.listRecentWorkspaces())
    }
  },
  setSessions: (sessions) =>
    set((state) => {
      // Prune pin/archive/unread entries of sessions that no longer exist
      const ids = new Set(sessions.map((s) => s.id))
      const pinnedSessionIds = state.pinnedSessionIds.filter((id) => ids.has(id))
      const archivedSessionIds = state.archivedSessionIds.filter((id) => ids.has(id))
      if (pinnedSessionIds.length !== state.pinnedSessionIds.length) {
        window.electronAPI.setStore('pinnedSessionIds', pinnedSessionIds)
      }
      if (archivedSessionIds.length !== state.archivedSessionIds.length) {
        window.electronAPI.setStore('archivedSessionIds', archivedSessionIds)
      }
      const unreadSessionIds = Object.fromEntries(
        Object.entries(state.unreadSessionIds).filter(([id]) => ids.has(id))
      )
      const composerDrafts = pruneComposerDrafts(state.composerDrafts, ids)
      return {
        sessions,
        sessionRecords: removeLiveSessionRecords(state.sessionRecords, ids),
        pinnedSessionIds,
        archivedSessionIds,
        unreadSessionIds,
        composerDrafts
      }
    }),
  registerSessions: (sessions) => {
    for (const session of sessions) get().addSession(session, false)
  },
  addSession: (session, select = true) => {
    let changed = false
    set((state) => {
      const previous = state.sessions.find((item) => item.id === session.id)
      const same =
        previous &&
        previous.cwd === session.cwd &&
        previous.title === session.title &&
        previous.createdAt === session.createdAt &&
        previous.status === session.status &&
        previous.resumeFrom === session.resumeFrom &&
        previous.sessionFile === session.sessionFile &&
        previous.resumedHistoryId === session.resumedHistoryId
      const nextCurrentSessionId = select ? session.id : state.currentSessionId
      if (same && nextCurrentSessionId === state.currentSessionId) return state
      changed = true
      return {
        sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)],
        sessionRecords: upsertLiveSessionRecord(state.sessionRecords, session),
        currentSessionId: nextCurrentSessionId
      }
    })
    if (!changed) return
    // Backfill the on-disk session file for newly-created sessions. A resumed
    // session carries an opaque history id instead, so Main never has to send
    // its durable transcript path back across preload.
    if (!session.resumeFrom && !session.sessionFile && !session.resumedHistoryId) {
      window.electronAPI.getSessionState(session.id).then((st) => {
        if (st?.sessionFile) get().setSessionFile(session.id, st.sessionFile)
      })
    }
    // Hydrate the (possibly already-running) subagent roster.
    void get().hydrateSubagents(session.id)
  },
  setSessionFile: (sessionId, sessionFile) =>
    set((state) => {
      const current = state.sessions.find((session) => session.id === sessionId)
      if (!current || current.sessionFile === sessionFile) return state
      return {
        sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, sessionFile } : s)),
        sessionRecords: updateSessionRecordFile(state.sessionRecords, sessionId, sessionFile)
      }
    }),
  setCurrentSessionId: (currentSessionId) => {
    // Re-attaching to a session re-hydrates its roster (reconcile any agents
    // that spawned while the user was elsewhere).
    if (currentSessionId) void get().hydrateSubagents(currentSessionId)
    set((state) => ({
      currentSessionId,
      // Selecting a session marks it read
      unreadSessionIds:
        currentSessionId && state.unreadSessionIds[currentSessionId]
          ? { ...state.unreadSessionIds, [currentSessionId]: false }
          : state.unreadSessionIds
    }))
  },
  hydrateSubagents: async (sessionId) => {
    const roster = await window.electronAPI.getSubagents(sessionId)
    if (roster === null) return
    set((state) => {
      const current = state.executions[sessionId] ?? emptyProjection(sessionId)
      const next = applyAgentRoster(current, roster)
      if (next === current) return state
      return { executions: { ...state.executions, [sessionId]: next } }
    })
  },
  applyHistoricalAgents: (sessionId, records) => {
    if (records.length === 0) return
    set((state) => {
      const current = state.executions[sessionId] ?? emptyProjection(sessionId)
      const next = applyHistoricalAgents(current, records)
      if (next === current) return state
      return { executions: { ...state.executions, [sessionId]: next } }
    })
  },
  recordSteer: (sessionId, text) => {
    set((state) => {
      const current = state.executions[sessionId]
      if (!current) return state
      const next = foldUserSteer(current, text)
      if (next === current) return state
      return { executions: { ...state.executions, [sessionId]: next } }
    })
  },
  addMessage: (sessionId, message) => set((state) => ({
    messages: {
      ...state.messages,
      [sessionId]: [...(state.messages[sessionId] || []), message]
    }
  })),
  updateMessage: (sessionId, messageId, patch) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: (state.messages[sessionId] || []).map((m) =>
          m.id === messageId ? { ...m, ...patch } : m
        )
      }
    })),
  setMessages: (sessionId, messages) =>
    set((state) => ({ messages: { ...state.messages, [sessionId]: messages } })),
  appendMessageContent: (sessionId, content) => set((state) => {
    const list = state.messages[sessionId] || []
    if (list.length === 0) {
      return {
        messages: {
          ...state.messages,
          [sessionId]: [{ id: crypto.randomUUID(), role: 'assistant', content }]
        }
      }
    }
    const last = list[list.length - 1]
    if (last.role !== 'assistant' || last.toolCall) {
      return {
        messages: {
          ...state.messages,
          [sessionId]: [...list, { id: crypto.randomUUID(), role: 'assistant', content }]
        }
      }
    }
    const updated = [...list]
    updated[updated.length - 1] = {
      ...last,
      content: last.content + content,
      // The first text delta after a thinking run closes it (for the elapsed time)
      ...(last.thinking && last.thinkingEndTs === undefined
        ? { thinkingEndTs: Date.now() }
        : {})
    }
    return { messages: { ...state.messages, [sessionId]: updated } }
  }),
  appendThinking: (sessionId, delta) =>
    set((state) => {
      const list = state.messages[sessionId] || []
      const now = Date.now()
      const last = list[list.length - 1]
      // Thinking streams before its message's text; once text started (or the
      // previous thinking run closed), a fresh message carries the new run.
      if (last && last.role === 'assistant' && !last.toolCall && !last.content && last.thinkingEndTs === undefined) {
        const updated = [...list]
        updated[updated.length - 1] = {
          ...last,
          thinking: (last.thinking ?? '') + delta,
          thinkingStartTs: last.thinkingStartTs ?? now
        }
        return { messages: { ...state.messages, [sessionId]: updated } }
      }
      return {
        messages: {
          ...state.messages,
          [sessionId]: [
            ...list,
            {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content: '',
              thinking: delta,
              thinkingStartTs: now
            }
          ]
        }
      }
    }),
  finalizeThinking: (sessionId) =>
    set((state) => {
      const list = state.messages[sessionId] || []
      const last = list[list.length - 1]
      if (!last || last.role !== 'assistant' || last.toolCall) return state
      if (!last.thinking || last.thinkingEndTs !== undefined) return state
      const updated = [...list]
      updated[updated.length - 1] = { ...last, thinkingEndTs: Date.now() }
      return { messages: { ...state.messages, [sessionId]: updated } }
    }),
  resolveUiRequest: (sessionId, requestId) =>
    set((state) => {
      const requests = state.uiRequests[sessionId] || []
      const index = requests.findIndex((request) => request.id === requestId)
      if (index === -1) return state
      // Remove one request only. Main prevents duplicate ids, but this keeps a
      // malformed upstream frame from clearing more than the user answered.
      return {
        uiRequests: {
          ...state.uiRequests,
          [sessionId]: [...requests.slice(0, index), ...requests.slice(index + 1)]
        }
      }
  }),
  setPackages: (packages) => set({ packages }),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  setActiveRightTab: (activeRightTab) => set({ activeRightTab }),
  setSelectedFile: (selectedFile) => set({ selectedFile }),
  setPreviewContent: (previewContent) => set({ previewContent }),
  setCheckpointUnavailable: (sessionId, unavailable) =>
    set((state) =>
      state.checkpointUnavailable[sessionId] === unavailable
        ? state
        : { checkpointUnavailable: { ...state.checkpointUnavailable, [sessionId]: unavailable } }
    ),
  bumpGitInfoVersion: () => set((state) => ({ gitInfoVersion: state.gitInfoVersion + 1 })),
  createCheckpointForMessage: async (sessionId, msgIndex, text) => {
    if (get().checkpointUnavailable[sessionId] === true) return
    const info = await window.electronAPI.checkpointCreate(sessionId, msgIndex, text.slice(0, 80))
    get().setCheckpointUnavailable(sessionId, info === null)
  },
  setCliAvailable: (cliAvailable) => set({ cliAvailable }),
  setBusy: (sessionId, busy) =>
    set((state) => ({ busy: { ...state.busy, [sessionId]: busy } })),
  setSessionError: (sessionId, key) =>
    set((state) => ({ sessionErrors: { ...state.sessionErrors, [sessionId]: key ?? undefined } })),
  clearSessionErrorIf: (sessionId, key) =>
    set((state) => {
      if (state.sessionErrors[sessionId] !== key) return state
      return { sessionErrors: { ...state.sessionErrors, [sessionId]: undefined } }
    }),
  enqueueQueuedMessage: (sessionId, message) =>
    set((state) => ({
      queuedMessages: {
        ...state.queuedMessages,
        [sessionId]: [...(state.queuedMessages[sessionId] || []), message]
      }
    })),
  removeQueuedMessage: (sessionId, id) =>
    set((state) => ({
      queuedMessages: {
        ...state.queuedMessages,
        [sessionId]: (state.queuedMessages[sessionId] || []).filter((m) => m.id !== id)
      },
      steeringQueuedIds: {
        ...state.steeringQueuedIds,
        [sessionId]: (state.steeringQueuedIds[sessionId] || []).filter((queuedId) => queuedId !== id)
      }
    })),
  reserveQueuedMessage: (sessionId, id) => {
    const state = get()
    if (!(state.queuedMessages[sessionId] || []).some((message) => message.id === id)) return false
    const reserved = state.steeringQueuedIds[sessionId] || []
    if (reserved.includes(id)) return false
    set((current) => ({
      steeringQueuedIds: {
        ...current.steeringQueuedIds,
        [sessionId]: [...(current.steeringQueuedIds[sessionId] || []), id]
      }
    }))
    return true
  },
  releaseQueuedMessage: (sessionId, id) =>
    set((state) => ({
      steeringQueuedIds: {
        ...state.steeringQueuedIds,
        [sessionId]: (state.steeringQueuedIds[sessionId] || []).filter((queuedId) => queuedId !== id)
      }
    })),
  shiftQueuedMessage: (sessionId) => {
    const state = get()
    const first = (state.queuedMessages[sessionId] || [])[0]
    if (!first) return undefined
    // A reserved head must stay in FIFO ownership until its Steer RPC is
    // acknowledged. Do not let an idle event drain it as a normal prompt.
    if ((state.steeringQueuedIds[sessionId] || []).includes(first.id)) return undefined
    set((state) => ({
      queuedMessages: {
        ...state.queuedMessages,
        [sessionId]: (state.queuedMessages[sessionId] || []).slice(1)
      }
    }))
    return first
  },
  drainQueuedMessage: (sessionId) => {
    const next = get().shiftQueuedMessage(sessionId)
    if (!next) return false
    // Snapshot the ACTUAL dispatch-time session state, so a queued turn
    // is tagged with the model/thinking it really runs under — even if the
    // user hot-switched the session model while it was queued.
    void captureSessionSnapshot(sessionId).then((snap) => {
      const bubbleId = crypto.randomUUID()
      get().addMessage(sessionId, {
        id: bubbleId,
        role: 'user',
        kind: 'prompt',
        content: next.text,
        images: next.images?.map(({ data, mimeType }) => ({ data, mimeType })),
        runtimeModel: snap.modelSelector,
        runtimeThinking: snap.thinkingLevel
      })
      set((state) => ({ busy: { ...state.busy, [sessionId]: true } }))
      void window.electronAPI
        .sendMessage(sessionId, next.text, next.images)
        .then((sent) => {
          if (sent) {
            // A queued item successfully became a normal prompt; clear only
            // the stale recoverable Steer feedback, never fatal session state.
            get().clearSessionErrorIf(sessionId, 'chat.steerQueueFailed')
            const list = get().messages[sessionId] || []
            void get().createCheckpointForMessage(sessionId, list.length - 1, next.text)
            void get().maybeNameSession(sessionId, next.text)
          } else {
            // The session died underneath the queue: stop draining into
            // the void — drop the rest, release busy, flag the failure.
            set((state) => ({ busy: { ...state.busy, [sessionId]: false } }))
            get().clearQueuedMessages(sessionId)
            get().setSessionError(sessionId, 'chat.sendFailed')
            get().updateMessage(sessionId, bubbleId, { failed: true })
          }
        })
    })
    return true
  },
  clearQueuedMessages: (sessionId) =>
    set((state) => ({
      queuedMessages: { ...state.queuedMessages, [sessionId]: [] },
      steeringQueuedIds: { ...state.steeringQueuedIds, [sessionId]: [] }
    })),
  setCompacting: (sessionId, compacting) =>
    set((state) => ({ compacting: { ...state.compacting, [sessionId]: compacting } })),
  setStats: (sessionId, stats) =>
    set((state) => ({ stats: { ...state.stats, [sessionId]: stats } })),
  setPinnedSessionIds: (pinnedSessionIds) => set({ pinnedSessionIds }),
  togglePinSession: (sessionId) =>
    set((state) => {
      const pinnedSessionIds = state.pinnedSessionIds.includes(sessionId)
        ? state.pinnedSessionIds.filter((id) => id !== sessionId)
        : [...state.pinnedSessionIds, sessionId]
      window.electronAPI.setStore('pinnedSessionIds', pinnedSessionIds)
      return { pinnedSessionIds }
    }),
  setArchivedSessionIds: (archivedSessionIds) => set({ archivedSessionIds }),
  setSessionArchived: (sessionId, archived) =>
    set((state) => {
      const archivedSessionIds = archived
        ? [...state.archivedSessionIds.filter((id) => id !== sessionId), sessionId]
        : state.archivedSessionIds.filter((id) => id !== sessionId)
      window.electronAPI.setStore('archivedSessionIds', archivedSessionIds)
      return { archivedSessionIds }
    }),
  markSessionUnread: (sessionId) =>
    set((state) => ({ unreadSessionIds: { ...state.unreadSessionIds, [sessionId]: true } })),
  setComposerPrefill: (composerPrefill) => set({ composerPrefill }),
  setComposerDraft: (sessionId, draft) =>
    set((state) => ({
      composerDrafts: setComposerDraft(state.composerDrafts, sessionId, draft)
    })),
  clearComposerDraft: (sessionId) =>
    set((state) => ({ composerDrafts: clearComposerDraft(state.composerDrafts, sessionId) })),
  setRecentProjects: (recentProjects) => set({ recentProjects }),
  setRecentWorkspaces: (recentWorkspaces) =>
    set({
      recentWorkspaces,
      recentProjects: recentWorkspaces.map((entry) => entry.displayPath)
    }),
  removeRecentProject: (displayPath) => {
    void window.electronAPI.removeRecentWorkspace(displayPath)
    set((state) => ({
      recentWorkspaces: state.recentWorkspaces.filter((entry) => entry.displayPath !== displayPath),
      recentProjects: state.recentProjects.filter((entry) => entry !== displayPath)
    }))
  },
  loadHistorySessions: async (grantId) => {
    if (!grantId) {
      set({ historyLoading: false })
      return
    }
    set({ historyLoading: true })
    const list = await window.electronAPI.listSessionHistory(grantId)
    // Ignore a stale response when the workspace was switched meanwhile; the
    // newer load owns the flag then.
    if (get().currentWorkspace?.id === grantId) {
      const workspaceRealPath = get().currentWorkspace?.realPath
      set((state) => ({
        sessionRecords: workspaceRealPath
          ? replaceHistoricalSessionRecords(state.sessionRecords, workspaceRealPath, list)
          : state.sessionRecords,
        historyLoading: false
      }))
    }
  },
  removeHistorySession: (historyId) =>
    set((state) => ({
      sessionRecords: removeHistoryRecord(state.sessionRecords, historyId)
    })),
  setSessionTitle: (sessionId, title) =>
    set((state) => {
      const current = state.sessions.find((session) => session.id === sessionId)
      if (!current || current.title === title) return state
      return {
        sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, title } : s)),
        sessionRecords: updateSessionRecordTitle(state.sessionRecords, sessionId, title)
      }
    }),
  maybeNameSession: async (sessionId, text) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === sessionId)
    if (!session) return
    const projectName = session.cwd.split('/').filter(Boolean).pop() || ''
    if (session.title.trim() && session.title !== projectName) return
    const list = state.messages[sessionId] || []
    if (list.filter((m) => m.role === 'user').length !== 1) return
    const name = text.replace(/\s+/g, ' ').trim().slice(0, 24)
    if (!name) return
    const ok = await window.electronAPI.setSessionName(sessionId, name)
    if (ok) get().setSessionTitle(sessionId, name)
  },
  setSetupComplete: (setupComplete) => {
    set({ setupComplete })
    window.electronAPI.setStore('setupComplete', setupComplete)
  },
  setInstallStatus: (installStatus) => set({ installStatus }),

  loadRuntimeOverview: async (force = false) => {
    const requestGeneration = ++runtimeOverviewRequestGeneration
    const runtimeOverview = await window.electronAPI.runtimeOverview(force)
    if (requestGeneration === runtimeOverviewRequestGeneration) set({ runtimeOverview })
  },

  loadRuntimeModels: async () => {
    const runtimeModels = await window.electronAPI.runtimeListModels()
    set({ runtimeModels })
  },

  loadRuntimeModelCatalog: async () => {
    const runtimeModelCatalog = await window.electronAPI.runtimeListModelCatalog()
    set({ runtimeModelCatalog })
  },

  selectRuntimeDefaultModel: async (selector) => {
    const result = await window.electronAPI.runtimeSetDefaultModel(selector)
    await get().loadRuntimeOverview(true)
    return result
  },

  setRuntimeDefaultThinking: async (level) => {
    const result = await window.electronAPI.runtimeSetDefaultThinking(level)
    await get().loadRuntimeOverview(true)
    return result
  },

  setRuntimeMachineSkills: async (enabled) => {
    const result = await window.electronAPI.runtimeSetMachineSkills(enabled)
    await get().loadRuntimeOverview(true)
    return result
  },

  setRuntimeApiKey: async (providerId, key) => {
    const result = await window.electronAPI.authSetApiKey(providerId, key)
    await get().loadRuntimeOverview(true)
    return result
  },

  startLogin: async (providerId) => {
    return window.electronAPI.authStartLogin(providerId)
  },

  answerLogin: async (answer) => {
    return window.electronAPI.authAnswerLogin(answer)
  },

  cancelLogin: async () => {
    return window.electronAPI.authCancelLogin()
  },

  openLoginUrl: async (url) => {
    return window.electronAPI.authOpenLoginUrl(url)
  },

  logoutProvider: async (providerId) => {
    const result = await window.electronAPI.authLogout(providerId)
    await get().loadRuntimeOverview(true)
    return result
  },

  loadModelState: async () => {
    const [modelConfig, models] = await Promise.all([
      window.electronAPI.getModelConfig(),
      window.electronAPI.listModels()
    ])
    set({ modelConfig, models })
  },

  setCurrentSessionModel: async (provider, modelId) => {
    const sid = get().currentSessionId
    if (!sid || !provider || !modelId) return false
    return window.electronAPI.setSessionModel(sid, provider, modelId)
  },

  setCurrentSessionThinking: async (level) => {
    const sid = get().currentSessionId
    if (!sid) return false
    return window.electronAPI.setThinkingLevel(sid, level)
  },

  setPendingModel: (selector) => set({ pendingModel: selector }),

  setPendingThinking: (level) => set({ pendingThinking: level }),

  getSessionOverrides: () => {
    const { pendingModel, pendingThinking } = get()
    return {
      ...(pendingModel ? { modelSelector: pendingModel } : {}),
      ...(pendingThinking ? { thinkingLevel: pendingThinking } : {})
    }
  },

  clearSessionOverrides: (overrides) => {
    set((state) => ({
      ...(overrides.modelSelector !== undefined && state.pendingModel === overrides.modelSelector
        ? { pendingModel: null }
        : {}),
      ...(overrides.thinkingLevel !== undefined && state.pendingThinking === overrides.thinkingLevel
        ? { pendingThinking: null }
        : {})
    }))
  },

  applySessionEvent: (event) => {
    // Fold into the single execution projection first — the Agent Hub and
    // trajectory surfaces both derive from this one fold, never a copy each.
    set((state) => {
      const current = state.executions[event.sessionId] ?? emptyProjection(event.sessionId)
      const next = foldExecutionEvent(current, event)
      if (next === current) return state
      return { executions: { ...state.executions, [event.sessionId]: next } }
    })

    if (event.type === 'message') {
      if (event.role === 'user') {
        get().addMessage(event.sessionId, {
          id: crypto.randomUUID(),
          role: 'user',
          content: event.content
        })
      } else {
        get().appendMessageContent(event.sessionId, event.content)
      }
    } else if (event.type === 'thinking') {
      get().appendThinking(event.sessionId, event.delta)
    } else if (event.type === 'tool_call') {
      // A tool call ends any open thinking run of the previous message
      get().finalizeThinking(event.sessionId)
      get().addMessage(event.sessionId, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        toolCall: {
          id: event.id,
          tool: event.tool,
          input: event.input,
          output: event.output
        }
      })
    } else if (event.type === 'tool_result') {
      // Merge the result into its tool-call card: by toolCallId when the event
      // carries one (parallel calls pair by id, order-independent); the legacy
      // name+recency fallback inside applyToolResult covers id-less events.
      set((state) => ({
        messages: {
          ...state.messages,
          [event.sessionId]: applyToolResult(state.messages[event.sessionId] || [], event)
        }
      }))
    } else if (event.type === 'status') {
      const wasBusy = Boolean(get().busy[event.sessionId])
      const nextBusy = STATUS_BUSY[event.status]
      if (event.status === 'working') {
        set((state) => ({ busy: { ...state.busy, [event.sessionId]: true } }))
      } else if (nextBusy === true) {
        // waiting_for_user / aborting: the turn is still open — stay busy.
        set((state) => ({ busy: { ...state.busy, [event.sessionId]: true } }))
      } else if (nextBusy === false) {
        // Turn ended: close any open thinking run and clear busy. The turn's
        // summary is derived from the execution projection — never a second copy.
        get().finalizeThinking(event.sessionId)
        set((state) => ({ busy: { ...state.busy, [event.sessionId]: false } }))
      }
      // Statuses outside STATUS_BUSY leave busy/turn state untouched.
      // working→idle with a non-empty queue: send the next queued message.
      // The wasBusy guard plus the optimistic busy=true below keep a stray or
      // repeated 'idle' from draining more than one message per real turn.
      if (event.status === 'idle' && wasBusy) {
        const drained = get().drainQueuedMessage(event.sessionId)
        if (!drained && event.sessionId !== get().currentSessionId) {
          // Turn finished in a background session — flag it unread
          get().markSessionUnread(event.sessionId)
        }
      }
    } else if (event.type === 'compaction') {
      set((state) => ({
        compacting: { ...state.compacting, [event.sessionId]: event.phase === 'start' }
      }))
    } else if (event.type === 'ui_request') {
      set((state) => {
        const requests = state.uiRequests[event.sessionId] || []
        // Keep renderer state in step with Main's request ledger, and never
        // let a duplicate upstream id create two indistinguishable dialogs.
        if (!event.id || requests.some((request) => request.id === event.id)) return state
        return {
          uiRequests: {
            ...state.uiRequests,
            [event.sessionId]: [...requests, event]
          }
        }
      })
    } else if (event.type === 'ui_cancel') {
      // The extension dismissed its own dialog — drop the pending request.
      set((state) => {
        const requests = state.uiRequests[event.sessionId] || []
        const index = requests.findIndex((request) => request.id === event.id)
        if (index === -1) return state
        return {
          uiRequests: {
            ...state.uiRequests,
            [event.sessionId]: [...requests.slice(0, index), ...requests.slice(index + 1)]
          }
        }
      })
    } else if (event.type === 'thinking_level_changed') {
      // Runtime-resolved level (may be clamped from the requested one);
      // pickers display exactly this, never the optimistic request.
      set((state) => ({
        sessionThinking: { ...state.sessionThinking, [event.sessionId]: event.level }
      }))
    } else if (event.type === 'model_changed') {
      // Session model changed; pickers refetch get_state for details.
      set((state) => ({
        sessionModelVersion: {
          ...state.sessionModelVersion,
          [event.sessionId]: (state.sessionModelVersion[event.sessionId] ?? 0) + 1
        }
      }))
    } else if (event.type === 'error') {
      get().addMessage(event.sessionId, {
        id: crypto.randomUUID(),
        role: 'system',
        content: `Error: ${event.message}`
      })
      // A dead session can't answer dialogs — drop them
      set((state) => ({
        uiRequests: { ...state.uiRequests, [event.sessionId]: [] },
        // A turn-ending failure (recoverable !== true) may arrive with no
        // following idle — e.g. an optimistically-busy prompt that never
        // reached agent_start — so release busy here or the session sticks
        // on "Running" forever. Recoverable errors never touch the turn.
        ...(event.recoverable !== true
          ? { busy: { ...state.busy, [event.sessionId]: false } }
          : {}),
        // recoverable === false means the process is gone: mark the session
        // dead in the sidebar and flag it in the chat header.
        ...(event.recoverable === false
          ? {
              sessions: state.sessions.map((s) =>
                s.id === event.sessionId ? { ...s, status: 'error' as const } : s
              )
            }
          : {})
      }))
      if (event.recoverable === false) {
        get().setSessionError(event.sessionId, 'chat.sessionDead')
      }
    } else if (event.type === 'closed') {
      set((state) => ({
        busy: { ...state.busy, [event.sessionId]: false },
        compacting: { ...state.compacting, [event.sessionId]: false },
        uiRequests: { ...state.uiRequests, [event.sessionId]: [] },
        queuedMessages: { ...state.queuedMessages, [event.sessionId]: [] },
        steeringQueuedIds: { ...state.steeringQueuedIds, [event.sessionId]: [] }
      }))
    }
  }
}))
