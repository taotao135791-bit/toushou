import { ipcMain, dialog, shell, app, BrowserWindow, IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC_CHANNELS } from '../shared/constants'
import {
  SessionEvent,
  AppSettings,
  InstallStatus,
  ReadFileResult,
  ExtensionUiAnswer,
  ModelConfig,
  CheckpointInfo,
  PermissionMode,
  StreamingBehavior,
  SessionThinkingLevel,
  DefaultThinkingLevel,
  SESSION_THINKING_LEVELS,
  DEFAULT_THINKING_LEVELS,
  SelectImageResult,
  LoginAnswer,
  LoginState,
  SubagentTranscriptSelector,
  WorkspaceGrant,
  RecentWorkspaceDescriptor,
  PluginScaffoldRequest,
  CustomProvidersListResult,
  CustomProviderSaveResult,
  CustomProviderDeleteResult,
  KimiComputerUseMutationResult,
  ManagedPluginDescriptor,
  ManagedPluginDetail,
  ManagedPluginSaveResult,
  ManagedPluginActionResult
} from '../shared/types'
import {
  detectCli,
  invalidateCliCache,
  getCapabilities,
  createSession,
  sendMessage,
  killSession,
  abortSession,
  listSessions,
  getSession,
  respondExtensionUi,
  setSessionModel,
  getSessionStats,
  listSessionCommands,
  compactSession,
  steer,
  followUp,
  setThinkingLevel,
  updateApprovalConfig,
  exportHtml,
  getSessionState,
  setSessionName,
  resumeSession,
  getSubagents,
  getSubagentMessages
} from './omp'
import {
  listPackages,
  installPackage,
  removePackage,
  updatePackage,
  setPackageEnabled,
  getPackageManagerCapabilities,
  defaultPiAgentDir
} from './packages'
import { getModelConfig, setModelConfig, setApiKey, clearApiKey, syncMachineSkills, listMachineSkillNames } from './piSettings'
import { listAvailableModels, listCatalogModels, invalidateModelCache } from './piModels'
import { getStore, rememberRecentProject, setStore } from './store'
import { installOmp } from './installer'
import { searchCommunityPackages } from './community'
import { scaffoldPlugin } from './pluginScaffold'
import { getKimiComputerUseStatus, setKimiComputerUseEnabled } from './kimiComputerUse'
import {
  deleteManagedPlugin,
  getManagedPlugin,
  listManagedPlugins,
  saveManagedPlugin,
  syncManagedPlugin
} from './managedPlugins'
import { OperationGrantManager } from './operationGrant'
import { FsGuard } from './fsGuard'
import {
  createCheckpoint,
  restoreCheckpoint,
  saveCheckpoint,
  listCheckpoints,
  getCheckpoint
} from './checkpoints'
import { getGitInfo, getFileDiff } from './gitinfo'
import { listSessionHistory, deleteSessionFile } from './sessionHistory'
import { HistorySessionGrantManager } from './historySessionGrant'
import { PackageActionGrantManager, matchesPackageActionTarget } from './packageActionGrant'
import { PackageLocalSourceGrantManager } from './packageLocalSourceGrant'
import { appendBoardNote, deleteBoard, listBoards, saveBoard } from './boards'
import { deleteDataset, importDataset, listDatasets, renameDataset } from './boardDatasets'
import { defaultExportFileName } from './exportPath'
import { listProjectFiles } from './projectFiles'
import { maybeNotifyTurnFinished, maybeNotifyUiRequest } from './notify'
import {
  getUpdaterStatus,
  updaterCheck,
  updaterDownload,
  updaterQuitAndInstall,
  updaterOpenReleasePage
} from './updater'
import {
  RuntimeSettings,
  isValidModelSelector,
  splitModelSelector
} from './omp/settings/RuntimeSettings'
import { PROVIDER_ID_PATTERN } from './omp/settings/modelSelector'
import { OmpLoginFlow } from './omp/settings/OmpLoginFlow'
import { configPath, makeExecRunner } from './omp/settings/OmpConfigCli'
import { listOmpModelCatalog, refreshModelCatalog } from './omp/settings/OmpModelCatalog'
import {
  clearProviderKey,
  deleteCustomProvider,
  listCustomProviders,
  sanitizeCustomProviderSpec,
  saveCustomProvider,
  saveProviderKey
} from './customProviders'
import { sanitizeImages } from './imageValidation'
import { RecentWorkspaceRegistry, WorkspaceGrantManager } from './workspaceGrant'
import { safeExternalUrl, safeLoginExternalUrl } from './navigation'
import { isUiAnswer } from './uiAnswer'

const fsGuard = new FsGuard()
const grantManager = new WorkspaceGrantManager({ fsGuard })
const operationGrantManager = new OperationGrantManager()
const operationGrantOwnerCleanupHooks = new Set<number>()
const historySessionGrantManager = new HistorySessionGrantManager()
const historySessionGrantOwnerCleanupHooks = new Set<number>()
const packageActionGrantManager = new PackageActionGrantManager()
const packageLocalSourceGrantManager = new PackageLocalSourceGrantManager()
const packageGrantOwnerCleanupHooks = new Set<number>()
const recentWorkspaceRegistry = new RecentWorkspaceRegistry(grantManager, {
  readPaths: () => getStore('recentProjects'),
  writePaths: (paths) => setStore('recentProjects', paths)
})

/** Runtime-settings facade, rebuilt whenever the CLI detection is invalidated. */
let runtimeSettings = new RuntimeSettings()
let loginFlow: OmpLoginFlow | null = null

function broadcastLoginState(state: LoginState): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.AUTH_LOGIN_STATE, state)
  }
}

const MAX_READ_FILE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

function broadcastSessionEvent(event: SessionEvent): void {
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.OMP_SESSION_EVENT, event)
    }
  }
  maybeNotifyTurnFinished(event)
  maybeNotifyUiRequest(event)
}

function sanitizeStreamingBehavior(value: unknown): StreamingBehavior | undefined {
  return value === 'steer' || value === 'followUp' ? value : undefined
}

/**
 * Sanitize a child-transcript selector from the renderer. Accepts a stable
 * subagentId (no control chars, bounded) and/or a sessionFile (also bounded),
 * plus an optional finite fromByte cursor. Existence is the runtime's call —
 * the GUI only guarantees IPC safety, never forwards arbitrary commands.
 */
function sanitizeSubagentSelector(value: unknown): SubagentTranscriptSelector {
  const out: SubagentTranscriptSelector = {}
  if (value && typeof value === 'object') {
    const v = value as Partial<SubagentTranscriptSelector>
    if (typeof v.subagentId === 'string' && isSafeId(v.subagentId)) out.subagentId = v.subagentId
    if (typeof v.sessionFile === 'string' && v.sessionFile.length <= 4096 && !hasControl(v.sessionFile)) {
      out.sessionFile = v.sessionFile
    }
    if (typeof v.fromByte === 'number' && Number.isFinite(v.fromByte) && v.fromByte >= 0) {
      out.fromByte = Math.trunc(v.fromByte)
    }
  }
  return out
}

/** An id that is a non-empty, control-char-free, reasonably-bounded string. */
function isSafeId(id: string): boolean {
  return id.length > 0 && id.length <= 512 && !hasControl(id)
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/

function hasControl(s: string): boolean {
  return CONTROL_RE.test(s)
}

/** Dialog filters from the renderer; falls back to the legacy ts/js default. */
function sanitizeDialogFilters(value: unknown): { name: string; extensions: string[] }[] {
  const fallback = [{ name: 'Extensions', extensions: ['ts', 'js'] }]
  if (!Array.isArray(value)) return fallback
  const out: { name: string; extensions: string[] }[] = []
  for (const f of value as Array<Partial<{ name: string; extensions: unknown[] }>>) {
    if (
      f &&
      typeof f.name === 'string' &&
      Array.isArray(f.extensions) &&
      f.extensions.every((e) => typeof e === 'string')
    ) {
      out.push({ name: f.name, extensions: f.extensions as string[] })
    }
  }
  return out.length ? out : fallback
}

const SESSION_LEVELS: readonly SessionThinkingLevel[] = SESSION_THINKING_LEVELS
const DEFAULT_LEVELS: readonly DefaultThinkingLevel[] = DEFAULT_THINKING_LEVELS

const PERMISSION_MODES: PermissionMode[] = ['full', 'no-bash', 'readonly', 'ask']

/** Resolve a renderer-supplied grant id to a canonical realPath. */
function requireGrant(id: unknown): { grant: WorkspaceGrant; realPath: string } | null {
  if (typeof id !== 'string' || !id.trim()) return null
  const grant = grantManager.get(id)
  if (!grant) return null
  return { grant, realPath: grant.realPath }
}

/** Purge short-lived file capabilities as soon as their renderer is gone. */
function bindOperationGrantOwnerCleanup(event: IpcMainInvokeEvent): void {
  const { sender } = event
  const ownerId = sender.id
  if (operationGrantOwnerCleanupHooks.has(ownerId)) return
  operationGrantOwnerCleanupHooks.add(ownerId)
  sender.once('destroyed', () => {
    operationGrantManager.revokeOwner(ownerId)
    operationGrantOwnerCleanupHooks.delete(ownerId)
  })
}

/** Revoke renderer-bound history capabilities when their webContents closes. */
function bindHistorySessionGrantOwnerCleanup(event: IpcMainInvokeEvent): void {
  const { sender } = event
  const ownerId = sender.id
  if (historySessionGrantOwnerCleanupHooks.has(ownerId)) return
  historySessionGrantOwnerCleanupHooks.add(ownerId)
  sender.once('destroyed', () => {
    historySessionGrantManager.revokeOwner(ownerId)
    historySessionGrantOwnerCleanupHooks.delete(ownerId)
  })
}

/** Revoke every renderer-bound package capability once its webContents closes. */
function bindPackageGrantOwnerCleanup(event: IpcMainInvokeEvent): void {
  const { sender } = event
  const ownerId = sender.id
  if (packageGrantOwnerCleanupHooks.has(ownerId)) return
  packageGrantOwnerCleanupHooks.add(ownerId)
  sender.once('destroyed', () => {
    packageActionGrantManager.revokeOwner(ownerId)
    packageLocalSourceGrantManager.revokeOwner(ownerId)
    packageGrantOwnerCleanupHooks.delete(ownerId)
  })
}

function safePackageDialogLabel(value: string): string {
  let cleaned = value.slice(0, 512)
  while (CONTROL_RE.test(cleaned)) cleaned = cleaned.replace(CONTROL_RE, ' ')
  cleaned = cleaned.trim().replace(/\s+/g, ' ')
  return (cleaned || 'package').slice(0, 180)
}

type PackageConfirmationAction = 'install' | 'update' | 'remove' | 'enable' | 'disable'

/**
 * Package installation executes third-party code. Keep the trust decision in
 * an Electron-owned dialog so compromised renderer content cannot perform it
 * silently, even if it can invoke a preload method.
 */
async function confirmPackageAction(
  event: IpcMainInvokeEvent,
  action: PackageConfirmationAction,
  label: string,
  detail?: string
): Promise<boolean> {
  const verbs: Record<PackageConfirmationAction, string> = {
    install: 'Install',
    update: 'Update',
    remove: 'Uninstall',
    enable: 'Enable',
    disable: 'Disable'
  }
  const verb = verbs[action]
  const codeWarning =
    action === 'install' || action === 'update'
      ? 'Plugins can run code with this app\'s permissions. Review the source before continuing.'
      : 'This changes the plugin state managed by Oh My Pi.'
  const options = {
    type: action === 'remove' ? 'warning' as const : 'question' as const,
    buttons: ['Cancel', verb],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: `${verb} plugin`,
    message: `${verb} “${safePackageDialogLabel(label)}”?`,
    detail: detail ? `${codeWarning}\n\n${detail}` : codeWarning
  }
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  return result.response === 1
}

/**
 * Enabling the bridge makes a separately installed Kimi CU MCP server
 * available to future OMP sessions. Keep this consent in a Main-owned native
 * dialog: a compromised renderer must not silently gain desktop input tools.
 */
async function confirmKimiComputerUseBridge(event: IpcMainInvokeEvent, enabled: boolean): Promise<boolean> {
  const verb = enabled ? 'Enable' : 'Disable'
  const options = {
    type: enabled ? 'warning' as const : 'question' as const,
    buttons: ['Cancel', verb],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: `${verb} Kimi Computer Use`,
    message: `${verb} the Kimi Computer Use bridge?`,
    detail: enabled
      ? 'Future OMP sessions can use Kimi CU to inspect desktop windows and send keyboard or pointer input. Keep the session permission mode on Ask unless you explicitly want unattended desktop actions.'
      : 'This removes only OMP GUI\'s Kimi CU MCP registration. Kimi CU itself and other MCP servers are left unchanged.'
  }
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  return result.response === 1
}

/** Remove known private paths/sources and credential fragments from CLI output. */
function redactPackageActionLog(value: unknown, privateValues: readonly (string | undefined)[]): string {
  let log = typeof value === 'string' ? value : ''
  const aliases = new Set<string>()
  for (const raw of privateValues) {
    if (!raw) continue
    aliases.add(raw)
    if (path.isAbsolute(raw)) {
      aliases.add(path.resolve(raw))
      if (raw.startsWith('/private/var/')) aliases.add(raw.slice('/private'.length))
      if (raw.startsWith('/var/')) aliases.add(`/private${raw}`)
    }
  }
  for (const alias of [...aliases].filter(Boolean).sort((a, b) => b.length - a.length)) {
    log = log.split(alias).join('[package source]')
  }
  // Do not return an access token embedded in an URL even if it did not
  // match a source spelling exactly (for example after CLI normalization).
  log = log.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):[^\s/@]+@/gi, '$1$2:[redacted]@')
  log = log.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
  return log
}

/**
 * Package-manager output can echo its local source argument. Scaffold output
 * paths are Main-only, so strip both macOS /var ↔ /private/var spellings
 * before returning the compact public PackageActionResult to the renderer.
 */
function redactScaffoldOutputLog(value: unknown, canonicalDir: string): string {
  let log = typeof value === 'string' ? value : ''
  const aliases = new Set<string>([canonicalDir, path.resolve(canonicalDir)])
  if (canonicalDir.startsWith('/private/var/')) aliases.add(canonicalDir.slice('/private'.length))
  if (canonicalDir.startsWith('/var/')) aliases.add(`/private${canonicalDir}`)
  for (const alias of [...aliases].filter(Boolean).sort((a, b) => b.length - a.length)) {
    log = log.split(alias).join('[generated plugin]')
  }
  return log
}

export function registerIpc() {
  ipcMain.handle(IPC_CHANNELS.OMP_DETECT, async (_event: IpcMainInvokeEvent, force?: boolean) => {
    if (force) {
      invalidateCliCache()
      // CLI may have changed (install/upgrade): rebuild the runtime-settings
      // facade and drop every cached probe result.
      runtimeSettings = new RuntimeSettings()
    }
    return detectCli()
  })

  // CLI version + RPC feature surface for the settings page.
  ipcMain.handle(IPC_CHANNELS.OMP_CAPABILITIES, async () => {
    return getCapabilities()
  })

  ipcMain.handle(
    IPC_CHANNELS.OMP_LIST_SESSIONS,
    async () => listSessions()
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_CREATE_SESSION,
    async (
      _event: IpcMainInvokeEvent,
      grantId: string,
      overrides?: { modelSelector?: unknown; thinkingLevel?: unknown }
    ) => {
      const resolved = requireGrant(grantId)
      if (!resolved) {
        throw new Error('createSession requires a valid WorkspaceGrant id')
      }
      const { realPath } = resolved
      // Next-session overrides: validated, spawn-arg scoped, one-shot.
      const modelSelector =
        typeof overrides?.modelSelector === 'string' &&
        isValidModelSelector(overrides.modelSelector) &&
        splitModelSelector(overrides.modelSelector)
          ? overrides.modelSelector
          : undefined
      const thinkingLevel = SESSION_LEVELS.includes(overrides?.thinkingLevel as SessionThinkingLevel)
        ? (overrides?.thinkingLevel as SessionThinkingLevel)
        : undefined
      return createSession(realPath, broadcastSessionEvent, {
        ...(modelSelector ? { modelSelector } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {})
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_SEND_MESSAGE,
    async (
      _event: IpcMainInvokeEvent,
      sessionId: string,
      text: string,
      images?: unknown,
      streamingBehavior?: unknown
    ) => {
      return sendMessage(
        sessionId,
        text,
        sanitizeImages(images),
        sanitizeStreamingBehavior(streamingBehavior)
      )
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_KILL_SESSION,
    async (_event: IpcMainInvokeEvent, sessionId: string) => {
      return killSession(sessionId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_ABORT_SESSION,
    async (_event: IpcMainInvokeEvent, sessionId: string) => {
      return abortSession(sessionId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_RESPOND_UI,
    async (_event: IpcMainInvokeEvent, sessionId: string, requestId: string, answer: ExtensionUiAnswer) => {
      if (typeof requestId !== 'string' || !requestId) return false
      if (!isUiAnswer(answer)) return false
      return respondExtensionUi(sessionId, requestId, answer)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_SET_MODEL,
    async (_event: IpcMainInvokeEvent, sessionId: string, provider: string, modelId: string) => {
      if (typeof provider !== 'string' || typeof modelId !== 'string') return false
      const selector = `${provider}/${modelId}`
      if (!splitModelSelector(selector)) return false
      return setSessionModel(sessionId, provider, modelId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PACKAGES_SEARCH,
    async (_event: IpcMainInvokeEvent, query: unknown, curatedOnly: unknown) => {
      return searchCommunityPackages(typeof query === 'string' ? query : '', curatedOnly === true)
    }
  )

  ipcMain.handle(IPC_CHANNELS.PI_LIST_MODELS, async () => {
    return listAvailableModels()
  })

  ipcMain.handle(
    IPC_CHANNELS.OMP_SESSION_STATS,
    async (_event: IpcMainInvokeEvent, sessionId: string) => {
      if (typeof sessionId !== 'string' || !sessionId) return null
      return getSessionStats(sessionId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_LIST_COMMANDS,
    async (_event: IpcMainInvokeEvent, sessionId: string) => {
      if (typeof sessionId !== 'string' || !sessionId) return []
      return listSessionCommands(sessionId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_COMPACT,
    async (_event: IpcMainInvokeEvent, sessionId: string) => {
      if (typeof sessionId !== 'string' || !sessionId) return false
      return compactSession(sessionId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_STEER,
    async (_event: IpcMainInvokeEvent, sessionId: string, message: string, images?: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId || typeof message !== 'string') return false
      return steer(sessionId, message, sanitizeImages(images))
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_FOLLOW_UP,
    async (_event: IpcMainInvokeEvent, sessionId: string, message: string, images?: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId || typeof message !== 'string') return false
      return followUp(sessionId, message, sanitizeImages(images))
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_SET_THINKING,
    async (_event: IpcMainInvokeEvent, sessionId: string, level: SessionThinkingLevel) => {
      if (typeof sessionId !== 'string' || !sessionId) return false
      if (!SESSION_LEVELS.includes(level)) return false
      return setThinkingLevel(sessionId, level)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_UPDATE_APPROVAL_CONFIG,
    async (_event: IpcMainInvokeEvent, sessionId: string, mode: PermissionMode) => {
      if (typeof sessionId !== 'string' || !sessionId) return false
      if (!PERMISSION_MODES.includes(mode)) return false
      return updateApprovalConfig(sessionId, mode)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_EXPORT_HTML,
    async (_event: IpcMainInvokeEvent, sessionId: string) => {
      if (typeof sessionId !== 'string' || !sessionId) return null
      // The renderer may NOT choose an arbitrary destination: the host always
      // exports to a Main-owned safe directory (Downloads) with a sanitized
      // filename, then reveals it in the Finder.
      const target = path.join(
        app.getPath('downloads'),
        defaultExportFileName(getSession(sessionId)?.title, sessionId)
      )
      const saved = await exportHtml(sessionId, target)
      if (saved) shell.showItemInFolder(saved)
      return saved
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_SESSION_STATE,
    async (_event: IpcMainInvokeEvent, sessionId: string) => {
      if (typeof sessionId !== 'string' || !sessionId) return null
      return getSessionState(sessionId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_LIST_SESSION_HISTORY,
    async (event: IpcMainInvokeEvent, grantId: string) => {
      const resolved = requireGrant(grantId)
      if (!resolved) return []
      bindHistorySessionGrantOwnerCleanup(event)
      const history = await listSessionHistory(resolved.realPath)
      return historySessionGrantManager.mintForWorkspace(history, {
        workspaceGrantId: resolved.grant.id,
        workspaceRealPath: resolved.realPath,
        ownerWebContentsId: event.sender.id
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_RESUME_SESSION,
    async (event: IpcMainInvokeEvent, grantId: string, historyId: unknown) => {
      const resolved = requireGrant(grantId)
      if (!resolved || typeof historyId !== 'string') return null
      bindHistorySessionGrantOwnerCleanup(event)
      return historySessionGrantManager.withResolved(
        historyId,
        {
          workspaceGrantId: resolved.grant.id,
          workspaceRealPath: resolved.realPath,
          ownerWebContentsId: event.sender.id
        },
        async (filePath) => {
          const resumed = await resumeSession(resolved.realPath, broadcastSessionEvent, filePath)
          if (!resumed) return null
          // The runtime keeps the file path in Main for --session and durable
          // metadata reconstruction. The renderer needs only the opaque
          // history capability to merge the resulting live row.
          const { resumeFrom: _resumeFrom, sessionFile: _sessionFile, ...session } = resumed.session
          return {
            ...resumed,
            session: { ...session, resumedHistoryId: historyId }
          }
        }
      )
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_DELETE_SESSION_FILE,
    async (event: IpcMainInvokeEvent, grantId: string, historyId: unknown) => {
      const resolved = requireGrant(grantId)
      if (!resolved) return false
      bindHistorySessionGrantOwnerCleanup(event)
      const deleted = await historySessionGrantManager.withResolved(historyId, {
        workspaceGrantId: resolved.grant.id,
        workspaceRealPath: resolved.realPath,
        ownerWebContentsId: event.sender.id
      }, async (filePath) => {
        const result = await deleteSessionFile(filePath)
        if (result) historySessionGrantManager.revoke(historyId)
        return result
      })
      return deleted === true
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_SET_SESSION_NAME,
    async (_event: IpcMainInvokeEvent, sessionId: string, name: string) => {
      if (typeof sessionId !== 'string' || !sessionId || typeof name !== 'string') return false
      return setSessionName(sessionId, name)
    }
  )

  // Subagent bridge — typed, validated. The renderer NEVER issues arbitrary OMP
  // commands; only these two read paths are exposed (roster + child transcript).
  ipcMain.handle(
    IPC_CHANNELS.OMP_GET_SUBAGENTS,
    async (_event: IpcMainInvokeEvent, sessionId: string) => {
      if (typeof sessionId !== 'string' || !sessionId) return null
      return getSubagents(sessionId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMP_GET_SUBAGENT_MESSAGES,
    async (_event: IpcMainInvokeEvent, sessionId: string, selector: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId) return null
      return getSubagentMessages(sessionId, sanitizeSubagentSelector(selector))
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_CREATE,
    async (_event: IpcMainInvokeEvent, sessionId: string, msgIndex: number, promptPreview: string) => {
      if (typeof sessionId !== 'string' || !sessionId) return null
      const session = getSession(sessionId)
      if (!session) return null
      const snapshot = await createCheckpoint(session.cwd)
      if (!snapshot) return null
      const info: CheckpointInfo = {
        id: crypto.randomUUID(),
        sessionId,
        sha: snapshot.sha,
        untracked: snapshot.untracked,
        promptPreview: typeof promptPreview === 'string' ? promptPreview.slice(0, 80) : '',
        msgIndex: typeof msgIndex === 'number' ? msgIndex : 0,
        createdAt: Date.now()
      }
      saveCheckpoint(info)
      return info
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_LIST,
    async (_event: IpcMainInvokeEvent, sessionId: string) => {
      if (typeof sessionId !== 'string' || !sessionId) return []
      return listCheckpoints(sessionId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHECKPOINT_RESTORE,
    async (_event: IpcMainInvokeEvent, id: string) => {
      if (typeof id !== 'string' || !id) return { ok: false, log: 'invalid checkpoint id' }
      const checkpoint = getCheckpoint(id)
      if (!checkpoint) return { ok: false, log: 'Checkpoint not found.' }
      const session = getSession(checkpoint.sessionId)
      if (!session) return { ok: false, log: 'Session is no longer running.' }
      return restoreCheckpoint(session.cwd, checkpoint.sha, checkpoint.untracked)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.GIT_INFO,
    async (_event: IpcMainInvokeEvent, grantId: string) => {
      const resolved = requireGrant(grantId)
      if (!resolved) return null
      return getGitInfo(resolved.realPath)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.GIT_FILE_DIFF,
    async (_event: IpcMainInvokeEvent, grantId: string, filePath: string) => {
      const resolved = requireGrant(grantId)
      if (!resolved) return null
      if (typeof filePath !== 'string' || !filePath.trim()) return null
      return getFileDiff(resolved.realPath, filePath)
    }
  )

  ipcMain.handle(IPC_CHANNELS.UPDATER_GET_STATUS, async () => {
    return getUpdaterStatus()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATER_CHECK, async () => {
    return updaterCheck()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATER_DOWNLOAD, async () => {
    return updaterDownload()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATER_QUIT_INSTALL, async () => {
    updaterQuitAndInstall()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATER_OPEN_PAGE, async () => {
    await updaterOpenReleasePage()
  })

  ipcMain.handle(
    IPC_CHANNELS.PI_SET_MACHINE_SKILLS,
    async (_event: IpcMainInvokeEvent, enabled: boolean) => {
      const on = enabled === true
      setStore('machineSkills', on)
      const excluded = syncMachineSkills(on)
      return { enabled: on, excluded, available: listMachineSkillNames() }
    }
  )

  // Read-only probe: which machine-local skills exist (no writes either way).
  ipcMain.handle(IPC_CHANNELS.PI_LIST_MACHINE_SKILLS, async () => {
    return listMachineSkillNames()
  })

  ipcMain.handle(IPC_CHANNELS.PI_LIST_CATALOG_MODELS, async () => {
    return listCatalogModels()
  })

  ipcMain.handle(IPC_CHANNELS.PI_GET_MODEL_CONFIG, async () => {
    return getModelConfig()
  })

  ipcMain.handle(
    IPC_CHANNELS.PI_SET_MODEL_CONFIG,
    async (_event, patch: Partial<Omit<ModelConfig, 'authProviders'>>) => {
      if (typeof patch !== 'object' || patch === null) {
        return { ok: false, log: 'invalid model config' }
      }
      return setModelConfig(patch)
    }
  )

  ipcMain.handle(IPC_CHANNELS.PI_SET_API_KEY, async (_event, provider: string, key: string) => {
    if (typeof key !== 'string') return { ok: false, log: 'invalid api key' }
    const result = setApiKey(String(provider ?? ''), key)
    if (result.ok) invalidateModelCache()
    return result
  })

  ipcMain.handle(IPC_CHANNELS.PI_CLEAR_API_KEY, async (_event, provider: string) => {
    const result = clearApiKey(String(provider ?? ''))
    if (result.ok) invalidateModelCache()
    return result
  })

  // ------------------------------------------------------- runtime settings
  // Unified runtime settings/auth API — the renderer renders profile +
  // capabilities; all version differences are absorbed in main.

  ipcMain.handle(IPC_CHANNELS.RUNTIME_OVERVIEW, async (_event, force?: boolean) => {
    return runtimeSettings.getOverview(force === true)
  })

  ipcMain.handle(IPC_CHANNELS.RUNTIME_LIST_MODELS, async () => {
    return runtimeSettings.listModels()
  })

  // Full static catalog — the Settings model dropdown (credential-independent).
  ipcMain.handle(IPC_CHANNELS.RUNTIME_LIST_MODEL_CATALOG, async () => {
    return listOmpModelCatalog()
  })

  ipcMain.handle(IPC_CHANNELS.RUNTIME_REFRESH_MODEL_CATALOG, async () => {
    return refreshModelCatalog()
  })

  ipcMain.handle(
    IPC_CHANNELS.RUNTIME_SET_DEFAULT_MODEL,
    async (_event, selector: unknown) => {
      // Single validator, same as set-session-model and next-session override.
      if (typeof selector !== 'string' || (selector !== '' && !isValidModelSelector(selector))) {
        return { ok: false, error: 'invalid model selector' }
      }
      return runtimeSettings.setDefaultModel(selector)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.RUNTIME_SET_DEFAULT_THINKING,
    async (_event, level: unknown) => {
      // Config enum (auto is legal, off is not) — verified against omp 17.2.12.
      if (typeof level !== 'string' || (level !== '' && !DEFAULT_LEVELS.includes(level as DefaultThinkingLevel))) {
        return { ok: false, error: 'invalid thinking level' }
      }
      return runtimeSettings.setDefaultThinking(level as DefaultThinkingLevel | '')
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.RUNTIME_SET_MACHINE_SKILLS,
    async (_event, enabled: unknown) => {
      return runtimeSettings.setMachineSkills(enabled === true)
    }
  )

  // ------------------------------------------------------- custom providers
  // opencode-style custom providers via omp's models.yml (current profile
  // only — legacy pi has no models.yml semantics and the UI hides the
  // section there). Writes are runtime-verified with rollback in main.

  ipcMain.handle(IPC_CHANNELS.CUSTOM_PROVIDERS_LIST, async (): Promise<CustomProvidersListResult> => {
    return listCustomProviders()
  })

  ipcMain.handle(
    IPC_CHANNELS.CUSTOM_PROVIDERS_SAVE,
    async (_event, raw: unknown): Promise<CustomProviderSaveResult> => {
      const spec = sanitizeCustomProviderSpec(raw)
      if (!spec) return { ok: false, error: 'invalid-spec' }
      return saveCustomProvider(spec)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CUSTOM_PROVIDERS_DELETE,
    async (_event, id: unknown): Promise<CustomProviderDeleteResult> => {
      if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) return { ok: false }
      return deleteCustomProvider(id)
    }
  )

  ipcMain.handle(IPC_CHANNELS.AUTH_START_LOGIN, async (_event, providerId: unknown) => {
    if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
      return { ok: false, error: 'invalid provider id' }
    }
    if (loginFlow?.active) {
      return { ok: false, error: 'a login flow is already running' }
    }
    const cli = detectCli()
    const flow = new OmpLoginFlow({
      cli,
      onState: broadcastLoginState,
      // No auto-open: key-based providers (DeepSeek, OpenRouter, xAI, …)
      // emit open_url just to point at the API-key dashboard before showing
      // the paste-key input. The URL is stashed in loginState and opened only
      // on explicit user action via AUTH_OPEN_LOGIN_URL.
      onOpenUrl: () => {}
    })
    loginFlow = flow
    // Fire-and-forget: progress rides the AUTH_LOGIN_STATE channel.
    void flow.start(providerId).finally(() => {
      runtimeSettings.invalidate()
      if (loginFlow === flow) loginFlow = null
    })
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.AUTH_ANSWER_LOGIN, async (_event, answer: LoginAnswer) => {
    if (!loginFlow?.active) return { ok: false, error: 'no active login flow' }
    if (!isUiAnswer(answer)) return { ok: false, error: 'invalid answer' }
    return { ok: loginFlow.answer(answer) }
  })

  ipcMain.handle(
    IPC_CHANNELS.AUTH_SET_API_KEY,
    async (_event, providerId: unknown, key: unknown) => {
      if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
        return { ok: false, error: 'invalid provider id' }
      }
      if (typeof key !== 'string' || !key.trim()) {
        return { ok: false, error: 'invalid api key' }
      }
      // models.yml override — the spawn-free credential path. The RPC login
      // flow stays available for interactive login (AUTH_START_LOGIN) but is
      // not used here: it can hang on prompt drift and leave the UI stuck.
      const result = await saveProviderKey(providerId, key)
      if (result.ok) runtimeSettings.invalidate()
      return result.ok
        ? { ok: true }
        : { ok: false, error: 'detail' in result ? (result.detail ?? result.error) : result.error }
    }
  )

  ipcMain.handle(IPC_CHANNELS.AUTH_CANCEL_LOGIN, async () => {
    loginFlow?.cancel()
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.AUTH_OPEN_LOGIN_URL, async (_event, url: unknown) => {
    const safeUrl = safeLoginExternalUrl(url)
    if (!safeUrl) return { ok: false, error: 'invalid url' }
    try {
      await shell.openExternal(safeUrl)
      return { ok: true }
    } catch {
      return { ok: false, error: 'open failed' }
    }
  })

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async (_event, providerId: unknown) => {
    if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
      return { ok: false, error: 'invalid provider id' }
    }
    // Clears both the models.yml override and any vault credential.
    const result = await clearProviderKey(providerId)
    if (result.ok) runtimeSettings.invalidate()
    return result
  })

  ipcMain.handle(IPC_CHANNELS.APP_VERSION, async () => {
    return app.getVersion()
  })

  ipcMain.handle(IPC_CHANNELS.OMP_INSTALL, async (event: IpcMainInvokeEvent) => {
    const sender = event.sender
    const success = await installOmp((status: InstallStatus) => {
      if (!sender.isDestroyed()) {
        sender.send(IPC_CHANNELS.OMP_INSTALL_STATUS, status)
      }
    })
    if (success) {
      invalidateCliCache()
    }
    return success
  })

  // Workspace authority: Main-owned grants. The renderer cannot pass an
  // arbitrary path and add it to FsGuard. It can only ask Main to (1) show the
  // native folder dialog, (2) re-authorize a persisted recent path, or (3)
  // re-activate a grant it already holds.
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SELECT, async (): Promise<WorkspaceGrant | null> => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const grant = await grantManager.createGrant(result.filePaths[0], 'dialog')
    if (grant) rememberRecentProject(grant.realPath)
    return grant
  })

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_ACTIVATE_RECENT,
    async (_event, recentId: string): Promise<WorkspaceGrant | null> => {
      return recentWorkspaceRegistry.activate(recentId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_LIST_RECENT,
    async (): Promise<RecentWorkspaceDescriptor[]> => recentWorkspaceRegistry.list()
  )

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CLEAR_RECENT, async (): Promise<boolean> => {
    await recentWorkspaceRegistry.clear()
    return true
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_REMOVE_RECENT, async (_event, displayPath: unknown): Promise<boolean> => {
    return recentWorkspaceRegistry.remove(displayPath)
  })

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_ACTIVATE,
    async (_event, grantId: string): Promise<WorkspaceGrant | null> => {
      if (typeof grantId !== 'string' || !grantId.trim()) return null
      const grant = grantManager.get(grantId)
      if (!grant) return null
      // Re-validate the real path still exists and is a directory.
      try {
        const st = await fs.promises.stat(grant.realPath)
        if (!st.isDirectory()) {
          grantManager.revoke(grantId)
          historySessionGrantManager.revokeWorkspace(grantId)
          return null
        }
      } catch {
        grantManager.revoke(grantId)
        historySessionGrantManager.revokeWorkspace(grantId)
        return null
      }
      return grant
    }
  )

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_REVOKE, async (_event, grantId: string): Promise<boolean> => {
    if (typeof grantId !== 'string' || !grantId.trim()) return false
    const revoked = grantManager.revoke(grantId)
    if (revoked) historySessionGrantManager.revokeWorkspace(grantId)
    return revoked
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST, async (): Promise<WorkspaceGrant[]> => {
    return grantManager.list()
  })

  // Deprecated: renderer self-authorization of filesystem roots.
  ipcMain.handle(IPC_CHANNELS.FS_SET_ROOT, async () => false)

  ipcMain.handle(
    IPC_CHANNELS.FS_LIST_DIR,
    async (_event, grantId: string, relativePath?: string) => {
      const resolved = requireGrant(grantId)
      if (!resolved) return []
      const dirPath = path.resolve(resolved.realPath, typeof relativePath === 'string' ? relativePath : '.')
      if (!fsGuard.isAllowed(dirPath)) return []
      const fsp = await import('node:fs/promises')
      try {
        const entries = await fsp.readdir(dirPath, { withFileTypes: true })
        return entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          path: path.join(typeof relativePath === 'string' ? relativePath : '', e.name).replace(/\\/g, '/')
        }))
      } catch {
        return []
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FS_LIST_PROJECT_FILES,
    async (_event, grantId: string): Promise<string[]> => {
      const resolved = requireGrant(grantId)
      if (!resolved) return []
      return listProjectFiles(resolved.realPath)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FS_READ_FILE,
    async (_event, grantId: string, relativePath: string): Promise<ReadFileResult> => {
      const resolved = requireGrant(grantId)
      if (!resolved) {
        return { ok: false, error: 'Access denied: invalid workspace grant.' }
      }
      const filePath = path.resolve(resolved.realPath, relativePath)
      if (!fsGuard.isAllowed(filePath)) {
        return { ok: false, error: 'Access denied: path is outside the allowed project folders.' }
      }
      const fs = await import('node:fs/promises')
      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) {
          return { ok: false, error: 'Not a regular file.' }
        }
        if (stat.size > MAX_READ_FILE_BYTES) {
          return {
            ok: false,
            error: `File too large to preview (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit 2 MB).`
          }
        }
        const buf = await fs.readFile(filePath)
        if (buf.subarray(0, 8192).includes(0)) {
          return { ok: false, error: 'Binary file cannot be previewed.' }
        }
        return { ok: true, content: buf.toString('utf-8') }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.PACKAGES_LIST, async (event: IpcMainInvokeEvent) => {
    bindPackageGrantOwnerCleanup(event)
    const [capabilities, packages] = await Promise.all([
      getPackageManagerCapabilities(),
      listPackages()
    ])
    return packageActionGrantManager.mintSnapshot(packages, {
      ownerWebContentsId: event.sender.id,
      profile: capabilities.profile
    })
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGES_CAPABILITIES, async () => {
    return getPackageManagerCapabilities()
  })

  /** Package sources become CLI argv — reject flags, controls and empty input. */
  function validSource(source: unknown): source is string {
    return (
      typeof source === 'string' &&
      source.trim().length > 0 &&
      source.trim().length < 500 &&
      !source.trim().startsWith('-') &&
      !hasControl(source)
    )
  }

  const stalePackageAction = { ok: false, log: 'Package list changed. Refresh and try again.' }
  const unavailableLocalSource = { ok: false, log: 'Selected local package is no longer available. Choose it again.' }
  const cancelledPackageAction = { ok: false, log: '' }

  async function performPackageRowAction(
    event: IpcMainInvokeEvent,
    packageId: unknown,
    action: 'remove' | 'update' | 'toggle',
    enabled?: boolean
  ) {
    bindPackageGrantOwnerCleanup(event)
    const lease = packageActionGrantManager.claimPackageAction(packageId, event.sender.id)
    if (!lease) return stalePackageAction

    let success = false
    try {
      const capabilities = await getPackageManagerCapabilities()
      const listed = await listPackages()
      const current = listed.find((pkg) => matchesPackageActionTarget(lease.target, pkg, capabilities.profile))
      if (!current) {
        packageActionGrantManager.revoke(lease.id)
        return stalePackageAction
      }
      if (action === 'update') {
        const canUpdate = current.canUpdate ?? (current.kind !== 'local' && !current.pinned)
        if (!capabilities.canUpdate || !canUpdate) {
          return { ok: false, log: 'This package cannot be updated by the active OMP version.' }
        }
      }
      if (action === 'toggle' && (!capabilities.canToggle || typeof enabled !== 'boolean')) {
        return { ok: false, log: 'This package cannot be enabled or disabled by the active OMP version.' }
      }

      const confirmationAction: PackageConfirmationAction =
        action === 'toggle' ? (enabled ? 'enable' : 'disable') : action
      if (!await confirmPackageAction(event, confirmationAction, lease.descriptor.name)) {
        return cancelledPackageAction
      }

      // A native confirmation may stay open for a while. Re-list after it
      // closes, then use only the Main-held target that still matches exactly.
      const currentAfterConfirmation = (await listPackages()).find((pkg) =>
        matchesPackageActionTarget(lease.target, pkg, capabilities.profile)
      )
      if (!currentAfterConfirmation) {
        packageActionGrantManager.revoke(lease.id)
        return stalePackageAction
      }

      const commandSource = lease.target.commandSource ?? lease.target.source
      const result =
        action === 'remove'
          ? await removePackage(commandSource, lease.target.scope)
          : action === 'update'
            ? await updatePackage(commandSource, lease.target.scope)
            : await setPackageEnabled(commandSource, enabled as boolean, undefined, lease.target.scope)
      success = result.ok
      return {
        ok: result.ok,
        log: redactPackageActionLog(result.log, [
          lease.target.source,
          lease.target.commandSource,
          current.path,
          currentAfterConfirmation.path
        ])
      }
    } catch (error) {
      return {
        ok: false,
        log: redactPackageActionLog(error instanceof Error ? error.message : String(error), [
          lease.target.source,
          lease.target.commandSource
        ])
      }
    } finally {
      packageActionGrantManager.finishPackageAction(lease.id, success)
    }
  }

  ipcMain.handle(IPC_CHANNELS.PACKAGES_INSTALL, async (event: IpcMainInvokeEvent, source: unknown) => {
    if (!validSource(source)) return { ok: false, log: 'invalid package source' }
    bindPackageGrantOwnerCleanup(event)
    const normalized = source.trim()
    if (!await confirmPackageAction(event, 'install', normalized, `Source: ${normalized}`)) {
      return cancelledPackageAction
    }
    try {
      const result = await installPackage(normalized)
      return { ok: result.ok, log: redactPackageActionLog(result.log, [normalized]) }
    } catch (error) {
      return {
        ok: false,
        log: redactPackageActionLog(error instanceof Error ? error.message : String(error), [normalized])
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGES_SELECT_LOCAL_SOURCE, async (event, kind: unknown) => {
    if (kind !== 'file' && kind !== 'directory') return null
    bindPackageGrantOwnerCleanup(event)
    const result = await dialog.showOpenDialog({
      properties: [kind === 'directory' ? 'openDirectory' : 'openFile'],
      ...(kind === 'file'
        ? { filters: [{ name: 'Plugin files', extensions: ['js', 'ts', 'mjs', 'cjs'] }] }
        : {})
    })
    if (result.canceled || !result.filePaths[0]) return null
    return packageLocalSourceGrantManager.mint(result.filePaths[0], event.sender.id)
  })

  ipcMain.handle(
    IPC_CHANNELS.PACKAGES_GRANT_DROPPED_LOCAL_SOURCE,
    async (event, trustedFilePath: unknown) => {
      if (typeof trustedFilePath !== 'string') return null
      bindPackageGrantOwnerCleanup(event)
      return packageLocalSourceGrantManager.mint(trustedFilePath, event.sender.id)
    }
  )

  ipcMain.handle(IPC_CHANNELS.PACKAGES_INSTALL_LOCAL_SOURCE, async (event, grantId: unknown) => {
    bindPackageGrantOwnerCleanup(event)
    const lease = await packageLocalSourceGrantManager.claim(grantId, event.sender.id)
    if (!lease) return unavailableLocalSource
    let success = false
    let source: string | null | undefined
    try {
      if (!await confirmPackageAction(event, 'install', lease.grant.name, 'Source: local selection')) {
        return cancelledPackageAction
      }
      source = await packageLocalSourceGrantManager.resolveClaimedPath(lease.id, event.sender.id)
      if (!source) return unavailableLocalSource
      const result = await installPackage(source)
      success = result.ok
      return { ok: result.ok, log: redactPackageActionLog(result.log, [source]) }
    } catch (error) {
      return {
        ok: false,
        log: redactPackageActionLog(error instanceof Error ? error.message : String(error), [source ?? undefined])
      }
    } finally {
      packageLocalSourceGrantManager.finish(lease.id, success)
    }
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGES_REMOVE, async (event, packageId: unknown) =>
    performPackageRowAction(event, packageId, 'remove')
  )

  ipcMain.handle(IPC_CHANNELS.PACKAGES_UPDATE, async (event, packageId: unknown) =>
    performPackageRowAction(event, packageId, 'update')
  )

  ipcMain.handle(IPC_CHANNELS.PACKAGES_SET_ENABLED, async (event, packageId: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return { ok: false, log: 'invalid package enabled state' }
    return performPackageRowAction(event, packageId, 'toggle', enabled)
  })

  // Kimi CU is an optional user-installed desktop runtime. Status is
  // read-only; adding/removing the OMP MCP registration always needs native
  // confirmation because it exposes desktop inspection/input to future agent
  // sessions.
  ipcMain.handle(IPC_CHANNELS.KIMI_CU_STATUS, async () => getKimiComputerUseStatus())
  ipcMain.handle(
    IPC_CHANNELS.KIMI_CU_SET_ENABLED,
    async (event: IpcMainInvokeEvent, enabled: unknown): Promise<KimiComputerUseMutationResult> => {
      const current = await getKimiComputerUseStatus()
      if (typeof enabled !== 'boolean') {
        return { ok: false, status: current, error: 'Invalid Kimi CU bridge state.' }
      }
      if (current.configured === enabled) return { ok: true, status: current }
      if (!await confirmKimiComputerUseBridge(event, enabled)) {
        return { ok: false, status: current, error: 'Cancelled.' }
      }
      return setKimiComputerUseEnabled(enabled)
    }
  )

  // Handwritten plugins live under app-owned userData. The renderer submits
  // metadata/code only; it never selects a write location or calls OMP. Sync
  // and delete are still native-confirmed runtime mutations.
  ipcMain.handle(
    IPC_CHANNELS.MANAGED_PLUGINS_LIST,
    async (): Promise<ManagedPluginDescriptor[]> => listManagedPlugins()
  )
  ipcMain.handle(
    IPC_CHANNELS.MANAGED_PLUGINS_GET,
    async (_event, id: unknown): Promise<ManagedPluginDetail | null> => getManagedPlugin(id)
  )
  ipcMain.handle(
    IPC_CHANNELS.MANAGED_PLUGINS_SAVE,
    async (_event, draft: unknown): Promise<ManagedPluginSaveResult> => saveManagedPlugin(draft)
  )
  ipcMain.handle(
    IPC_CHANNELS.MANAGED_PLUGINS_SYNC,
    async (event: IpcMainInvokeEvent, id: unknown): Promise<ManagedPluginActionResult> => {
      const plugin = getManagedPlugin(id)
      if (!plugin) return { ok: false, error: 'The handwritten plugin source is unavailable.', log: '' }
      if (!await confirmPackageAction(event, 'install', plugin.name, 'Source: OMP GUI handwritten plugin')) {
        return { ok: false, error: 'Cancelled.', log: '' }
      }
      return syncManagedPlugin(id)
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.MANAGED_PLUGINS_DELETE,
    async (event: IpcMainInvokeEvent, id: unknown): Promise<ManagedPluginActionResult> => {
      const plugin = getManagedPlugin(id)
      if (!plugin) return { ok: false, error: 'The handwritten plugin source is unavailable.', log: '' }
      if (!await confirmPackageAction(
        event,
        'remove',
        plugin.name,
        'This removes the runtime link and deletes the OMP GUI managed source.'
      )) {
        return { ok: false, error: 'Cancelled.', log: '' }
      }
      return deleteManagedPlugin(id)
    }
  )

  /**
   * The renderer cannot supply a parent path. It may only send the opaque
   * DirectoryGrant id produced by Main's native directory picker; Main then
   * resolves it immediately before scaffoldPlugin writes any files.
   */
  function sanitizeScaffoldRequest(raw: unknown): PluginScaffoldRequest | null {
    if (!raw || typeof raw !== 'object') return null
    const s = raw as Record<string, unknown>
    if (typeof s.name !== 'string' || typeof s.parentGrantId !== 'string') return null
    if (s.name.length > 250 || s.parentGrantId.length > 200 || hasControl(s.parentGrantId)) return null
    const opt = (v: unknown) =>
      typeof v === 'string' && v.trim().length > 0 && v.length <= 500 ? v.trim() : undefined
    return {
      name: s.name.trim(),
      displayName: opt(s.displayName),
      description: typeof s.description === 'string' ? s.description.slice(0, 2000) : '',
      version: typeof s.version === 'string' && s.version.trim() ? s.version.trim() : '0.1.0',
      author: opt(s.author),
      parentGrantId: s.parentGrantId,
      extension: s.extension === true,
      skill: s.skill === true,
      prompt: s.prompt === true,
      template: s.template === 'command' || s.template === 'tool-guard' ? s.template : 'blank'
    }
  }

  ipcMain.handle(IPC_CHANNELS.PLUGINS_SCAFFOLD_SELECT_DIRECTORY, async (event) => {
    bindOperationGrantOwnerCleanup(event)
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return operationGrantManager.mintPluginScaffoldDirectory(result.filePaths[0], event.sender.id)
  })

  ipcMain.handle(IPC_CHANNELS.PLUGINS_SCAFFOLD, async (event, raw: unknown) => {
    bindOperationGrantOwnerCleanup(event)
    const request = sanitizeScaffoldRequest(raw)
    if (!request) return { ok: false, error: 'invalid-spec' }
    const lease = await operationGrantManager.claimPluginScaffoldDirectory(
      request.parentGrantId,
      event.sender.id
    )
    if (!lease) return { ok: false, error: 'invalid-grant' }
    let success = false
    try {
      const { parentGrantId: _parentGrantId, ...spec } = request
      const result = scaffoldPlugin({ ...spec, parentDir: lease.parentDir })
      success = result.ok
      if (!result.ok) {
        // Node's filesystem errors often include the absolute target path. Do
        // not let an internal scaffold result cross preload verbatim now that
        // the selected directory itself is an opaque capability.
        return {
          ok: false,
          error: result.error,
          ...(result.error === 'write-failed'
            ? { detail: 'Could not write the generated package files. Check folder permissions and try again.' }
            : {})
        }
      }

      // The scaffold result's canonical directory stays in Main. The renderer
      // receives only this owner-bound opaque output capability for follow-up
      // reveal/install actions.
      const output = await operationGrantManager.mintPluginScaffoldOutput(result.dir, event.sender.id)
      if (!output) {
        return {
          ok: false,
          error: 'write-failed',
          detail: 'The generated plugin could not be retained for follow-up actions.'
        }
      }
      return { ok: true, output, files: result.files }
    } finally {
      operationGrantManager.finishPluginScaffoldDirectory(lease.id, success)
    }
  })

  ipcMain.handle(IPC_CHANNELS.PLUGINS_SCAFFOLD_REVEAL, async (event, outputId: unknown) => {
    bindOperationGrantOwnerCleanup(event)
    const outputDir = await operationGrantManager.revealPluginScaffoldOutput(outputId, event.sender.id)
    if (!outputDir) return false
    shell.showItemInFolder(outputDir)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.PLUGINS_SCAFFOLD_INSTALL, async (event, outputId: unknown) => {
    bindOperationGrantOwnerCleanup(event)
    const lease = await operationGrantManager.claimPluginScaffoldOutputInstall(outputId, event.sender.id)
    if (!lease) return { ok: false, log: 'Generated plugin is no longer available; create it again.' }
    let success = false
    try {
      const result = await installPackage(lease.dir)
      success = result.ok
      // `runCli` carries stdout/stderr at runtime even though installPackage's
      // public TypeScript type is PackageActionResult. Pick only the public
      // fields and redact every known spelling of the Main-held source path.
      return { ok: result.ok, log: redactScaffoldOutputLog(result.log, lease.dir) }
    } finally {
      operationGrantManager.finishPluginScaffoldOutputInstall(lease.id, success)
    }
  })

  ipcMain.handle(IPC_CHANNELS.SHELL_SHOW_CLI_SETTINGS, async () => {
    const cli = detectCli()
    if (cli.command === 'omp') {
      if (!cli.available) return false
      const configDir = await configPath(makeExecRunner(cli.path ?? cli.command))
      if (!configDir) return false
      return (await shell.openPath(configDir)) === ''
    }
    const settingsFile = path.join(defaultPiAgentDir(), 'settings.json')
    shell.showItemInFolder(settingsFile)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_EXTERNAL_URL, async (_event, value: unknown) => {
    const url = safeExternalUrl(value)
    if (!url) return { ok: false, error: 'invalid-url' }
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch {
      return { ok: false, error: 'open-failed' }
    }
  })

  ipcMain.handle(IPC_CHANNELS.STORE_GET, async (_event, key: keyof AppSettings) => {
    return getStore(key)
  })

  ipcMain.handle(IPC_CHANNELS.STORE_SET, async (_event, key: keyof AppSettings, value: unknown) => {
    if (key === 'recentProjects') return false
    setStore(key, value as never)
    // Transitional: the settings UI still writes the legacy toolAccess tier;
    // mirror it into permissionMode until the renderer exposes 'ask' itself.
    if (key === 'toolAccess' && (value === 'full' || value === 'no-bash' || value === 'readonly')) {
      setStore('permissionMode', value)
    }
    return true
  })

  // Kanban boards — dedicated module, never the generic store:set. The board
  // payload crosses the trust boundary as `unknown`; structural validation
  // (shapes, length/count limits) happens inside boards.ts via validateBoard.
  ipcMain.handle(IPC_CHANNELS.BOARDS_LIST, async () => {
    return listBoards()
  })

  ipcMain.handle(IPC_CHANNELS.BOARDS_SAVE, async (_event, board: unknown) => {
    return saveBoard(board)
  })

  ipcMain.handle(IPC_CHANNELS.BOARDS_DELETE, async (_event, id: unknown) => {
    return deleteBoard(id)
  })

  // Chat → board is intentionally a narrow Main-side append, never a
  // renderer-owned whole-board overwrite. Main re-reads the latest board and
  // validates the bounded note before writing it.
  ipcMain.handle(IPC_CHANNELS.BOARDS_APPEND_NOTE, async (_event, request: unknown) => {
    return appendBoardNote(request)
  })

  // Board datasets — file paths never cross from the renderer. Main mints a
  // one-use FileGrant from the native picker (or trusted preload's real Finder
  // File extraction), then resolves the id privately for the import.
  ipcMain.handle(IPC_CHANNELS.BOARDS_DATASETS_LIST, async () => {
    return listDatasets()
  })

  ipcMain.handle(IPC_CHANNELS.BOARDS_DATASETS_SELECT_FILE, async (event) => {
    bindOperationGrantOwnerCleanup(event)
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'CSV / Excel', extensions: ['csv', 'xlsx', 'xls'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return operationGrantManager.mintBoardDatasetFile(result.filePaths[0], event.sender.id)
  })

  ipcMain.handle(IPC_CHANNELS.BOARDS_DATASETS_GRANT_DROPPED_FILE, async (event, trustedPath: unknown) => {
    // This channel is invoked only by preload after webUtils.getPathForFile
    // accepts a real dropped File. Never expose it as a renderer string API.
    if (typeof trustedPath !== 'string') return null
    bindOperationGrantOwnerCleanup(event)
    return operationGrantManager.mintBoardDatasetFile(trustedPath, event.sender.id)
  })

  ipcMain.handle(IPC_CHANNELS.BOARDS_DATASETS_IMPORT, async (event, fileGrantId: unknown) => {
    const filePath = await operationGrantManager.consumeBoardDatasetFile(fileGrantId, event.sender.id)
    if (!filePath) return { ok: false, error: 'invalid-path' }
    return importDataset(filePath)
  })

  ipcMain.handle(IPC_CHANNELS.BOARDS_DATASETS_DELETE, async (_event, id: unknown) => {
    return deleteDataset(id)
  })

  ipcMain.handle(
    IPC_CHANNELS.BOARDS_DATASETS_RENAME,
    async (_event, id: unknown, name: unknown) => {
      return renameDataset(id, name)
    }
  )

  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FILE, async (_event, filters?: unknown) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: sanitizeDialogFilters(filters)
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Image picker for the composer. The dialog itself is the user's consent,
  // so (like selectFile) the chosen path is read without the fsGuard root check.
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_IMAGE, async (): Promise<SelectImageResult> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: Object.keys(IMAGE_MIME_BY_EXT) }]
    })
    const filePath = result.canceled ? undefined : result.filePaths[0]
    if (!filePath) return null
    const mimeType = IMAGE_MIME_BY_EXT[path.extname(filePath).slice(1).toLowerCase()]
    if (!mimeType) return { ok: false, error: 'notImage' }
    const fs = await import('node:fs/promises')
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > MAX_IMAGE_BYTES) return { ok: false, error: 'tooLarge' }
      const buf = await fs.readFile(filePath)
      return { ok: true, name: path.basename(filePath), data: buf.toString('base64'), mimeType }
    } catch {
      return { ok: false, error: 'readFailed' }
    }
  })
}
