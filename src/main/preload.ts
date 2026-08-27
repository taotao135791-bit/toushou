import { contextBridge, ipcRenderer, webUtils, IpcRendererEvent } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import {
  CliCapabilities,
  CliInfo,
  Session,
  SessionEvent,
  SessionStats,
  SlashCommand,
  PackageDescriptor,
  PackageActionResult,
  PackageManagerCapabilities,
  AppSettings,
  InstallStatus,
  ReadFileResult,
  ExtensionUiAnswer,
  ModelConfig,
  PiModel,
  CommunityPackageInfo,
  CheckpointInfo,
  GitInfo,
  PromptImage,
  SessionState,
  StreamingBehavior,
  SessionThinkingLevel,
  PermissionMode,
  SelectImageResult,
  UpdaterStatus,
  ChatMessage,
  HistorySessionDescriptor,
  RuntimeOverview,
  RuntimeModelInfo,
  LoginState,
  LoginAnswer,
  SubagentSnapshot,
  SubagentMessagesResult,
  SubagentTranscriptSelector,
  HistoricalAgentRecord,
  WorkspaceGrant,
  RecentWorkspaceDescriptor,
  FileGrant,
  DirectoryGrant,
  PluginScaffoldRequest,
  PluginScaffoldResult,
  KanbanBoard,
  BoardNoteAppendRequest,
  BoardNoteAppendResult,
  BoardDataset,
  CustomProviderSpec,
  CustomProvidersListResult,
  CustomProviderSaveResult,
  CustomProviderDeleteResult,
  PackageLocalSourceGrant,
  KimiComputerUseStatus,
  KimiComputerUseMutationResult,
  ManagedPluginDraft,
  ManagedPluginDescriptor,
  ManagedPluginDetail,
  ManagedPluginSaveResult,
  ManagedPluginActionResult
} from '../shared/types'
import { KanbanSaveResult } from '../shared/boards'
import { DatasetImportResult, DatasetMutationResult } from '../shared/datasets'

export interface ElectronAPI {
  detectCli: (force?: boolean) => Promise<CliInfo>
  /** CLI version + RPC feature surface of the detected CLI. */
  getCapabilities: () => Promise<CliCapabilities>
  listSessions: () => Promise<Session[]>
  /** Create a session under a Main-owned workspace grant. */
  createSession: (
    grantId: string,
    overrides?: { modelSelector?: string; thinkingLevel?: SessionThinkingLevel }
  ) => Promise<Session>
  sendMessage: (
    sessionId: string,
    text: string,
    images?: PromptImage[],
    streamingBehavior?: StreamingBehavior
  ) => Promise<boolean>
  killSession: (sessionId: string) => Promise<boolean>
  abortSession: (sessionId: string) => Promise<boolean>
  onSessionEvent: (callback: (event: SessionEvent) => void) => () => void
  installOmp: () => Promise<boolean>
  onInstallStatus: (callback: (status: InstallStatus) => void) => () => void
  /** @deprecated Workspace authority is grant-based; this stub returns false. */
  setFsRoot: (root: string) => Promise<boolean>
  listDir: (
    grantId: string,
    relativePath?: string
  ) => Promise<{ name: string; isDirectory: boolean; path: string }[]>
  readFile: (grantId: string, relativePath: string) => Promise<ReadFileResult>
  /** Flat relative-path file list of a project under a workspace grant. */
  listProjectFiles: (grantId: string) => Promise<string[]>
  /** Show the native folder dialog and mint a new WorkspaceGrant. */
  selectWorkspace: () => Promise<WorkspaceGrant | null>
  /** Re-authorize a Main-listed recent workspace by its opaque id. */
  activateRecentWorkspace: (recentId: string) => Promise<WorkspaceGrant | null>
  /** List currently valid recent workspaces from Main's registry. */
  listRecentWorkspaces: () => Promise<RecentWorkspaceDescriptor[]>
  /** Clear Main's recent workspace registry. */
  clearRecentWorkspaces: () => Promise<boolean>
  /** Remove one Main-listed recent workspace from the registry. */
  removeRecentWorkspace: (displayPath: string) => Promise<boolean>
  /** Re-activate an existing grant if its real path is still valid. */
  activateWorkspace: (grantId: string) => Promise<WorkspaceGrant | null>
  /** Revoke a workspace grant and drop its FsGuard root. */
  revokeWorkspaceGrant: (grantId: string) => Promise<boolean>
  /** List active workspace grants. */
  listWorkspaceGrants: () => Promise<WorkspaceGrant[]>
  /** Path-free, opaque package rows; ids authorize row mutations. */
  listPackages: () => Promise<PackageDescriptor[]>
  getPackageCapabilities: () => Promise<PackageManagerCapabilities>
  /** Search the npm registry for community pi packages (keyword pi-package). */
  searchPackages: (query: string, curatedOnly?: boolean) => Promise<CommunityPackageInfo[]>
  /** Native chooser for a local package source; returns no filesystem path. */
  selectPackageLocalSource: (kind: 'file' | 'directory') => Promise<PackageLocalSourceGrant | null>
  /** Convert a real Finder-dropped File into a path-free local-source grant. */
  grantDroppedPackageLocalSource: (file: File) => Promise<PackageLocalSourceGrant | null>
  installPackage: (source: string) => Promise<PackageActionResult>
  /** Install the Main-held local source selected above. */
  installPackageLocalSource: (grantId: string) => Promise<PackageActionResult>
  removePackage: (packageId: string) => Promise<PackageActionResult>
  updatePackage: (packageId: string) => Promise<PackageActionResult>
  setPackageEnabled: (packageId: string, enabled: boolean) => Promise<PackageActionResult>
  /** Detect the separately installed Kimi CU runtime without touching desktop state. */
  getKimiComputerUseStatus: () => Promise<KimiComputerUseStatus>
  /** Explicitly add/remove OMP GUI's managed Kimi CU MCP bridge registration. */
  setKimiComputerUseEnabled: (enabled: boolean) => Promise<KimiComputerUseMutationResult>
  /** App-owned handwritten plugin sources (no filesystem paths cross preload). */
  listManagedPlugins: () => Promise<ManagedPluginDescriptor[]>
  getManagedPlugin: (id: string) => Promise<ManagedPluginDetail | null>
  saveManagedPlugin: (draft: ManagedPluginDraft) => Promise<ManagedPluginSaveResult>
  syncManagedPlugin: (id: string) => Promise<ManagedPluginActionResult>
  deleteManagedPlugin: (id: string) => Promise<ManagedPluginActionResult>
  /** Native directory picker for one opaque plugin-scaffold write grant. */
  selectPluginScaffoldDirectory: () => Promise<DirectoryGrant | null>
  /** Scaffold a new pi package under the DirectoryGrant selected above. */
  scaffoldPlugin: (request: PluginScaffoldRequest) => Promise<PluginScaffoldResult>
  /** Reveal the Main-held directory from a successful plugin scaffold. */
  revealScaffoldedPlugin: (outputId: string) => Promise<boolean>
  /** Install the Main-held directory from a successful plugin scaffold. */
  installScaffoldedPlugin: (outputId: string) => Promise<PackageActionResult>
  /** Safely open an ordinary HTTP(S) URL in the system browser. */
  openExternalUrl: (url: string) => Promise<{ ok: boolean; error?: string }>
  getStore: <K extends keyof AppSettings>(key: K) => Promise<AppSettings[K]>
  setStore: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<boolean>
  /** Kanban boards (local-only, validated in main on every read/write). */
  listBoards: () => Promise<KanbanBoard[]>
  /** Whole-board upsert; rejects structurally invalid boards. */
  saveBoard: (board: KanbanBoard) => Promise<KanbanSaveResult>
  deleteBoard: (id: string) => Promise<KanbanSaveResult>
  /** Atomically append one bounded note to the latest persisted board. */
  appendBoardNote: (request: BoardNoteAppendRequest) => Promise<BoardNoteAppendResult>
  /** Imported CSV/XLSX datasets board widgets can bind to. */
  listBoardDatasets: () => Promise<BoardDataset[]>
  /** Native file picker for one opaque board-dataset import grant. */
  selectBoardDatasetFile: () => Promise<FileGrant | null>
  /** Turn a real Finder-dropped File into one opaque board-dataset import grant. */
  grantDroppedBoardDatasetFile: (file: File) => Promise<FileGrant | null>
  /** Import a CSV/XLSX dataset through its opaque FileGrant id. */
  importBoardDataset: (fileGrantId: string) => Promise<DatasetImportResult>
  deleteBoardDataset: (id: string) => Promise<DatasetMutationResult>
  renameBoardDataset: (id: string, name: string) => Promise<DatasetMutationResult>
  selectFolder: () => Promise<string | null>
  selectFile: (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>
  /** Pick an image file; resolves its base64 bytes (null when cancelled). */
  selectImage: () => Promise<SelectImageResult>
  showCliSettings: () => Promise<boolean>
  respondUi: (sessionId: string, requestId: string, answer: ExtensionUiAnswer) => Promise<boolean>
  setSessionModel: (sessionId: string, provider: string, modelId: string) => Promise<boolean>
  /** Token/context usage of a session; null when unavailable. */
  getSessionStats: (sessionId: string) => Promise<SessionStats | null>
  /** Slash commands (extensions/prompts/skills) available in a session. */
  listCommands: (sessionId: string) => Promise<SlashCommand[]>
  /** Trigger context compaction for a session. */
  compactSession: (sessionId: string) => Promise<boolean>
  /** Inject a steering message into a running turn. */
  steer: (sessionId: string, message: string, images?: PromptImage[]) => Promise<boolean>
  /** Queue a message delivered after the current turn finishes. */
  followUp: (sessionId: string, message: string, images?: PromptImage[]) => Promise<boolean>
  /** Change the thinking level of a live session. */
  setThinkingLevel: (sessionId: string, level: SessionThinkingLevel) => Promise<boolean>
  /** Rewrite a live session's approval-extension config (permission mode hot-swap). */
  updateApprovalConfig: (sessionId: string, mode: PermissionMode) => Promise<boolean>
  /** Export the session transcript as HTML to the host's Downloads dir; resolves the path. */
  exportHtml: (sessionId: string) => Promise<string | null>
  /** Live RPC get_state snapshot of a session; null when unavailable. */
  getSessionState: (sessionId: string) => Promise<SessionState | null>
  /** Persisted sessions of a workspace, represented by opaque Main-held ids. */
  listSessionHistory: (grantId: string) => Promise<HistorySessionDescriptor[]>
  /** Resume an opaque history entry under the workspace grant that listed it. */
  resumeSession: (
    grantId: string,
    historyId: string
  ) => Promise<{ session: Session; messages: ChatMessage[]; historicalAgents: HistoricalAgentRecord[] } | null>
  /** Delete an opaque history entry under the workspace grant that listed it. */
  deleteSessionFile: (grantId: string, historyId: string) => Promise<boolean>
  /** Set a session's display name (single line, max 60 chars). */
  setSessionName: (sessionId: string, name: string) => Promise<boolean>
  /** Live subagent roster (get_subagents); null when unsupported/unavailable. */
  getSubagents: (sessionId: string) => Promise<SubagentSnapshot[] | null>
  /** Incrementally read a child agent transcript (get_subagent_messages). */
  getSubagentMessages: (
    sessionId: string,
    selector: SubagentTranscriptSelector
  ) => Promise<SubagentMessagesResult | null>
  /** Snapshot the session's project as a git checkpoint; null for non-git dirs. */
  checkpointCreate: (
    sessionId: string,
    msgIndex: number,
    promptPreview: string
  ) => Promise<CheckpointInfo | null>
  checkpointList: (sessionId: string) => Promise<CheckpointInfo[]>
  /** Restore the project to a checkpoint; deletes files created after it. */
  checkpointRestore: (id: string) => Promise<PackageActionResult>
  /** Working-tree change summary for the changes panel; null for non-git dirs. */
  gitInfo: (grantId: string) => Promise<GitInfo | null>
  /** Unified diff of one file (synthetic new-file diff for untracked files). */
  gitFileDiff: (grantId: string, filePath: string) => Promise<string | null>
  /** Toggle loading of machine-local ~/.agents/skills; returns what changed. */
  setMachineSkills: (enabled: boolean) => Promise<{ enabled: boolean; excluded: string[]; available: string[] }>
  /** Read-only: names of machine-local skills present under ~/.agents/skills. */
  listMachineSkills: () => Promise<string[]>
  getModelConfig: () => Promise<ModelConfig>
  setModelConfig: (patch: Partial<Omit<ModelConfig, 'authProviders'>>) => Promise<PackageActionResult>
  setApiKey: (provider: string, key: string) => Promise<PackageActionResult>
  clearApiKey: (provider: string) => Promise<PackageActionResult>
  listModels: () => Promise<PiModel[]>
  /** pi's full built-in model registry, credentials not required. */
  listCatalogModels: () => Promise<PiModel[]>
  getAppVersion: () => Promise<string>
  /** Current auto-update state. */
  updaterGetStatus: () => Promise<UpdaterStatus>
  /** Manually check for updates; { status: 'dev' } in development. */
  updaterCheck: () => Promise<UpdaterStatus>
  /** Download the available update; progress arrives via onUpdaterStatus. */
  updaterDownload: () => Promise<UpdaterStatus>
  updaterQuitAndInstall: () => Promise<void>
  /** Open the releases page in the browser — manual fallback for unsigned builds. */
  updaterOpenReleasePage: () => Promise<void>
  onUpdaterStatus: (callback: (status: UpdaterStatus) => void) => () => void
  /** Fired when a completion notification is clicked; selects the session. */
  onNotifySelectSession: (callback: (sessionId: string) => void) => () => void
  /** Real filesystem path for a File dropped from Finder (contextIsolation-safe). */
  getPathForFile: (file: File) => string

  // ------------------------------------------------------- runtime settings
  /** Runtime-reported settings overview (profile, providers, capabilities, defaults). */
  runtimeOverview: (force?: boolean) => Promise<RuntimeOverview>
  /** Runtime model catalog (credential-filtered by the runtime). */
  runtimeListModels: () => Promise<RuntimeModelInfo[]>
  /** Full static model catalog (credential-independent) for the Settings picker. */
  runtimeListModelCatalog: () => Promise<RuntimeModelInfo[]>
  /** Download the latest model catalog into userData (takes effect for future reads). */
  runtimeRefreshModelCatalog: () => Promise<{ ok: boolean; providers?: number; error?: string }>
  /** Set the new-session default model; '' resets to the runtime default. Read-after-write verified. */
  runtimeSetDefaultModel: (selector: string) => Promise<{ ok: boolean; error?: string }>
  /** Set the default thinking level for new sessions. Read-after-write verified. */
  runtimeSetDefaultThinking: (level: string) => Promise<{ ok: boolean; error?: string }>
  /** Toggle machine-local skills via the runtime config (current profile). */
  runtimeSetMachineSkills: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>
  /** List custom providers from models.yml (never carries key material). */
  customProvidersList: () => Promise<CustomProvidersListResult>
  /** Upsert a custom provider; runtime-verified, rolled back when omp rejects it. */
  customProvidersSave: (spec: CustomProviderSpec) => Promise<CustomProviderSaveResult>
  /** Remove a custom provider from models.yml. */
  customProvidersDelete: (id: string) => Promise<CustomProviderDeleteResult>
  /** Start the runtime's native login flow; progress rides onLoginState. */
  authStartLogin: (providerId: string) => Promise<{ ok: boolean; error?: string }>
  /** Set a provider's API key directly (paste-key form, provider-validated). */
  authSetApiKey: (providerId: string, key: string) => Promise<{ ok: boolean; error?: string }>
  /** Answer the pending login prompt (input/select/confirm, or cancel). */
  authAnswerLogin: (answer: LoginAnswer) => Promise<{ ok: boolean; error?: string }>
  /** Cancel the running login flow (kills the runtime operation). */
  authCancelLogin: () => Promise<{ ok: boolean; error?: string }>
  /** Open a login URL the runtime asked for (explicit user action). */
  authOpenLoginUrl: (url: string) => Promise<{ ok: boolean; error?: string }>
  /** Remove a provider credential via the runtime; read-after-write verified. */
  authLogout: (providerId: string) => Promise<{ ok: boolean; error?: string }>
  /** Login flow state stream. */
  onLoginState: (callback: (state: LoginState) => void) => () => void
}

const api: ElectronAPI = {
  detectCli: (force?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.OMP_DETECT, force),
  getCapabilities: () => ipcRenderer.invoke(IPC_CHANNELS.OMP_CAPABILITIES),
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.OMP_LIST_SESSIONS),
  createSession: (grantId: string, overrides?: { modelSelector?: string; thinkingLevel?: SessionThinkingLevel }) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_CREATE_SESSION, grantId, overrides),
  sendMessage: (
    sessionId: string,
    text: string,
    images?: PromptImage[],
    streamingBehavior?: StreamingBehavior
  ) => ipcRenderer.invoke(IPC_CHANNELS.OMP_SEND_MESSAGE, sessionId, text, images, streamingBehavior),
  killSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.OMP_KILL_SESSION, sessionId),
  abortSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_ABORT_SESSION, sessionId),
  onSessionEvent: (callback: (event: SessionEvent) => void) => {
    const handler = (_event: IpcRendererEvent, ev: SessionEvent) => callback(ev)
    ipcRenderer.on(IPC_CHANNELS.OMP_SESSION_EVENT, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OMP_SESSION_EVENT, handler)
    }
  },
  installOmp: () => ipcRenderer.invoke(IPC_CHANNELS.OMP_INSTALL),
  onInstallStatus: (callback: (status: InstallStatus) => void) => {
    const handler = (_event: IpcRendererEvent, status: InstallStatus) => callback(status)
    ipcRenderer.on(IPC_CHANNELS.OMP_INSTALL_STATUS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OMP_INSTALL_STATUS, handler)
    }
  },
  setFsRoot: (_root: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_SET_ROOT),
  listDir: (grantId: string, relativePath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FS_LIST_DIR, grantId, relativePath),
  readFile: (grantId: string, relativePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FS_READ_FILE, grantId, relativePath),
  listProjectFiles: (grantId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FS_LIST_PROJECT_FILES, grantId),
  selectWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SELECT),
  activateRecentWorkspace: (recentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ACTIVATE_RECENT, recentId),
  listRecentWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST_RECENT),
  clearRecentWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CLEAR_RECENT),
  removeRecentWorkspace: (displayPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE_RECENT, displayPath),
  activateWorkspace: (grantId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ACTIVATE, grantId),
  revokeWorkspaceGrant: (grantId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REVOKE, grantId),
  listWorkspaceGrants: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST),
  listPackages: () => ipcRenderer.invoke(IPC_CHANNELS.PACKAGES_LIST),
  getPackageCapabilities: () => ipcRenderer.invoke(IPC_CHANNELS.PACKAGES_CAPABILITIES),
  searchPackages: (query: string, curatedOnly?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACKAGES_SEARCH, query, curatedOnly),
  selectPackageLocalSource: (kind: 'file' | 'directory') =>
    ipcRenderer.invoke(IPC_CHANNELS.PACKAGES_SELECT_LOCAL_SOURCE, kind),
  grantDroppedPackageLocalSource: async (file: File) => {
    const filePath = webUtils.getPathForFile(file)
    if (!filePath) return null
    return ipcRenderer.invoke(IPC_CHANNELS.PACKAGES_GRANT_DROPPED_LOCAL_SOURCE, filePath)
  },
  installPackage: (source: string) => ipcRenderer.invoke(IPC_CHANNELS.PACKAGES_INSTALL, source),
  installPackageLocalSource: (grantId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACKAGES_INSTALL_LOCAL_SOURCE, grantId),
  removePackage: (packageId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACKAGES_REMOVE, packageId),
  updatePackage: (packageId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACKAGES_UPDATE, packageId),
  setPackageEnabled: (packageId: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACKAGES_SET_ENABLED, packageId, enabled),
  getKimiComputerUseStatus: () => ipcRenderer.invoke(IPC_CHANNELS.KIMI_CU_STATUS),
  setKimiComputerUseEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.KIMI_CU_SET_ENABLED, enabled),
  listManagedPlugins: () => ipcRenderer.invoke(IPC_CHANNELS.MANAGED_PLUGINS_LIST),
  getManagedPlugin: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MANAGED_PLUGINS_GET, id),
  saveManagedPlugin: (draft: ManagedPluginDraft) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_PLUGINS_SAVE, draft),
  syncManagedPlugin: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MANAGED_PLUGINS_SYNC, id),
  deleteManagedPlugin: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MANAGED_PLUGINS_DELETE, id),
  selectPluginScaffoldDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_SCAFFOLD_SELECT_DIRECTORY),
  scaffoldPlugin: (request: PluginScaffoldRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_SCAFFOLD, request),
  revealScaffoldedPlugin: (outputId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_SCAFFOLD_REVEAL, outputId),
  installScaffoldedPlugin: (outputId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_SCAFFOLD_INSTALL, outputId),
  openExternalUrl: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL_URL, url),
  getStore: (key: keyof AppSettings) => ipcRenderer.invoke(IPC_CHANNELS.STORE_GET, key),
  setStore: (key: keyof AppSettings, value: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.STORE_SET, key, value),
  listBoards: () => ipcRenderer.invoke(IPC_CHANNELS.BOARDS_LIST),
  saveBoard: (board: KanbanBoard) => ipcRenderer.invoke(IPC_CHANNELS.BOARDS_SAVE, board),
  deleteBoard: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.BOARDS_DELETE, id),
  appendBoardNote: (request: BoardNoteAppendRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOARDS_APPEND_NOTE, request),
  listBoardDatasets: () => ipcRenderer.invoke(IPC_CHANNELS.BOARDS_DATASETS_LIST),
  selectBoardDatasetFile: () => ipcRenderer.invoke(IPC_CHANNELS.BOARDS_DATASETS_SELECT_FILE),
  grantDroppedBoardDatasetFile: async (file: File) => {
    // webUtils only accepts a real renderer File object. The raw path stays in
    // trusted preload and Main mints an opaque grant before the renderer sees it.
    try {
      const filePath = webUtils.getPathForFile(file)
      if (!filePath) return null
      return await ipcRenderer.invoke(IPC_CHANNELS.BOARDS_DATASETS_GRANT_DROPPED_FILE, filePath)
    } catch {
      return null
    }
  },
  importBoardDataset: (fileGrantId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOARDS_DATASETS_IMPORT, fileGrantId),
  deleteBoardDataset: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.BOARDS_DATASETS_DELETE, id),
  renameBoardDataset: (id: string, name: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOARDS_DATASETS_RENAME, id, name),
  selectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDER),
  selectFile: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FILE, filters),
  selectImage: () => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_IMAGE),
  showCliSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SHELL_SHOW_CLI_SETTINGS),
  respondUi: (sessionId: string, requestId: string, answer: ExtensionUiAnswer) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_RESPOND_UI, sessionId, requestId, answer),
  setSessionModel: (sessionId: string, provider: string, modelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_SET_MODEL, sessionId, provider, modelId),
  getSessionStats: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_SESSION_STATS, sessionId),
  listCommands: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_LIST_COMMANDS, sessionId),
  compactSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_COMPACT, sessionId),
  steer: (sessionId: string, message: string, images?: PromptImage[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_STEER, sessionId, message, images),
  followUp: (sessionId: string, message: string, images?: PromptImage[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_FOLLOW_UP, sessionId, message, images),
  setThinkingLevel: (sessionId: string, level: SessionThinkingLevel) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_SET_THINKING, sessionId, level),
  updateApprovalConfig: (sessionId: string, mode: PermissionMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_UPDATE_APPROVAL_CONFIG, sessionId, mode),
  exportHtml: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_EXPORT_HTML, sessionId),
  getSessionState: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_SESSION_STATE, sessionId),
  listSessionHistory: (grantId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_LIST_SESSION_HISTORY, grantId),
  resumeSession: (grantId: string, historyId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_RESUME_SESSION, grantId, historyId),
  deleteSessionFile: (grantId: string, historyId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_DELETE_SESSION_FILE, grantId, historyId),
  setSessionName: (sessionId: string, name: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_SET_SESSION_NAME, sessionId, name),
  getSubagents: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_GET_SUBAGENTS, sessionId),
  getSubagentMessages: (sessionId: string, selector: SubagentTranscriptSelector) =>
    ipcRenderer.invoke(IPC_CHANNELS.OMP_GET_SUBAGENT_MESSAGES, sessionId, selector),
  checkpointCreate: (sessionId: string, msgIndex: number, promptPreview: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_CREATE, sessionId, msgIndex, promptPreview),
  checkpointList: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_LIST, sessionId),
  checkpointRestore: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_RESTORE, id),
  gitInfo: (grantId: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_INFO, grantId),
  gitFileDiff: (grantId: string, filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_FILE_DIFF, grantId, filePath),
  setMachineSkills: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.PI_SET_MACHINE_SKILLS, enabled),
  listMachineSkills: () => ipcRenderer.invoke(IPC_CHANNELS.PI_LIST_MACHINE_SKILLS),
  getModelConfig: () => ipcRenderer.invoke(IPC_CHANNELS.PI_GET_MODEL_CONFIG),
  setModelConfig: (patch: Partial<Omit<ModelConfig, 'authProviders'>>) =>
    ipcRenderer.invoke(IPC_CHANNELS.PI_SET_MODEL_CONFIG, patch),
  setApiKey: (provider: string, key: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PI_SET_API_KEY, provider, key),
  clearApiKey: (provider: string) => ipcRenderer.invoke(IPC_CHANNELS.PI_CLEAR_API_KEY, provider),
  listModels: () => ipcRenderer.invoke(IPC_CHANNELS.PI_LIST_MODELS),
  listCatalogModels: () => ipcRenderer.invoke(IPC_CHANNELS.PI_LIST_CATALOG_MODELS),
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_VERSION),
  updaterGetStatus: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_GET_STATUS),
  updaterCheck: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_CHECK),
  updaterDownload: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_DOWNLOAD),
  updaterQuitAndInstall: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_QUIT_INSTALL),
  updaterOpenReleasePage: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_OPEN_PAGE),
  onUpdaterStatus: (callback: (status: UpdaterStatus) => void) => {
    const handler = (_event: IpcRendererEvent, status: UpdaterStatus) => callback(status)
    ipcRenderer.on(IPC_CHANNELS.UPDATER_STATUS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATER_STATUS, handler)
    }
  },
  onNotifySelectSession: (callback: (sessionId: string) => void) => {
    const handler = (_event: IpcRendererEvent, sessionId: string) => callback(sessionId)
    ipcRenderer.on(IPC_CHANNELS.NOTIFY_SELECT_SESSION, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.NOTIFY_SELECT_SESSION, handler)
    }
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  runtimeOverview: (force?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_OVERVIEW, force),
  runtimeListModels: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_LIST_MODELS),
  runtimeListModelCatalog: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_LIST_MODEL_CATALOG),
  runtimeRefreshModelCatalog: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_REFRESH_MODEL_CATALOG),
  runtimeSetDefaultModel: (selector: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_SET_DEFAULT_MODEL, selector),
  runtimeSetDefaultThinking: (level: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_SET_DEFAULT_THINKING, level),
  runtimeSetMachineSkills: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_SET_MACHINE_SKILLS, enabled),
  customProvidersList: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_PROVIDERS_LIST),
  customProvidersSave: (spec: CustomProviderSpec) =>
    ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_PROVIDERS_SAVE, spec),
  customProvidersDelete: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_PROVIDERS_DELETE, id),
  authStartLogin: (providerId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTH_START_LOGIN, providerId),
  authSetApiKey: (providerId: string, key: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTH_SET_API_KEY, providerId, key),
  authAnswerLogin: (answer: LoginAnswer) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTH_ANSWER_LOGIN, answer),
  authCancelLogin: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_CANCEL_LOGIN),
  authOpenLoginUrl: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_OPEN_LOGIN_URL, url),
  authLogout: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGOUT, providerId),
  onLoginState: (callback: (state: LoginState) => void) => {
    const handler = (_event: IpcRendererEvent, state: LoginState) => callback(state)
    ipcRenderer.on(IPC_CHANNELS.AUTH_LOGIN_STATE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AUTH_LOGIN_STATE, handler)
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
