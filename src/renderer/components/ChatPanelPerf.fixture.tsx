import { Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import type { ProjectRecord, RuntimeModelInfo, RuntimeOverview, Session, SessionState, SessionThinkingSelection, SkillEntry, SkillReadResult, WorkspaceGrant } from '@shared/types'
import ChatPanel from './ChatPanel'
import ExecutionActivity from './ExecutionActivity'
import MessageList from './MessageList'
import { emptyProjection, foldExecutionEvent } from '../lib/execution'
import { useAppStore, type MessageLike } from '../store'
import { useProjects } from '../store/projects'

const current: Session = { id: 'current', cwd: '/synthetic/current', title: 'Current conversation', status: 'idle', createdAt: 1 }
const sessions: Session[] = [current, ...Array.from({ length: 200 }, (_, i) => ({ ...current, id: `background-${i}`, title: `Background ${i}` }))]
const defaultProject: ProjectRecord = { id: 'default', name: 'TouShou workspace', path: '/synthetic/default-save-folder', isDefault: true, archived: false, missing: true, unavailableReason: 'identity-changed', createdAt: 1 }
const defaultGrant: WorkspaceGrant = { id: 'grant-default', realPath: defaultProject.path, displayPath: defaultProject.path, source: 'default', createdAt: 1 }
const skill: SkillEntry = { id: 'synthetic.md', name: 'Synthetic team skill', author: '', description: '', kind: 'markdown', sizeBytes: 12, updatedAtMillis: 1 }
const reviewSessionId = 'background-0'
const hydrationSessionId = 'idle-transcript'
let transcriptReady = false
let resolveSkill: ((result: SkillReadResult) => void) | undefined
const probeSessionId = 'projection-probe'
const probeMessages: MessageLike[] = [
  { id: 'projection-probe-prompt', role: 'user', content: 'Check the task' },
  { id: 'projection-probe-tool', role: 'assistant', content: '', toolCall: { tool: 'read', input: {}, output: {} } }
]
const deepSeekModel: RuntimeModelInfo = {
  provider: 'deepseek', id: 'deepseek-flash', selector: 'deepseek/deepseek-flash', name: 'DeepSeek-V4.1-Flash',
  reasoning: true, thinking: ['low', 'high', 'max']
}
const mediumOnlyModel: RuntimeModelInfo = {
  provider: 'synthetic-budget', id: 'analysis', selector: 'synthetic-budget/analysis', name: 'Synthetic budget model',
  reasoning: true, thinking: ['medium']
}
const plainModel: RuntimeModelInfo = {
  provider: 'synthetic-plain', id: 'chat', selector: 'synthetic-plain/chat', name: 'Synthetic plain model',
  reasoning: false, thinking: []
}
const fixtureModels = [deepSeekModel, mediumOnlyModel, plainModel]
const runtimeOverview: RuntimeOverview = {
  profile: 'current',
  capabilities: { providers: 'supported', nativeLogin: 'unknown', logout: 'unknown', modelCatalog: 'supported', defaultModelConfig: 'supported', defaultThinkingConfig: 'supported', machineSkillsConfig: 'unknown' },
  providers: [],
  modelState: { defaultModel: deepSeekModel.selector, defaultModelExplicit: true, defaultThinkingLevel: 'auto' },
  machineSkillsState: 'unknown'
}
const thinkingTimers = new Set<number>()
const browserWindow: Window = window
const setInterval = browserWindow.setInterval.bind(browserWindow)
const clearInterval = browserWindow.clearInterval.bind(browserWindow)
browserWindow.setInterval = (handler, timeout, ...args) => {
  const timer = setInterval(handler, timeout, ...args)
  if (timeout === 1000) thinkingTimers.add(timer)
  return timer
}
browserWindow.clearInterval = (timer) => {
  if (timer !== undefined) thinkingTimers.delete(timer)
  clearInterval(timer)
}

let releasePluginCatalog!: () => void
const pluginCatalogReady = new Promise<void>(resolve => { releasePluginCatalog = resolve })
let resolveManualCompact: (() => void) | undefined

const fixture = {
  releasePluginCatalog,
  commits: 0, renderMs: 0, backgroundUpdates: 0,
  compactCalls: 0,
  finishManualCompact() { resolveManualCompact?.() },
  startAutoCompact() {
    useAppStore.getState().setBusy(current.id, true)
    useAppStore.getState().applySessionEvent({ type: 'compaction', sessionId: current.id, source: 'auto', phase: 'start' })
  },
  finishAutoCompact() {
    useAppStore.getState().applySessionEvent({ type: 'compaction', sessionId: current.id, source: 'auto', phase: 'end', outcome: 'compacted' })
    useAppStore.getState().setBusy(current.id, false)
  },
  finishTurn() { useAppStore.getState().setBusy(current.id, false) },
  updateEstimatedTurn(status: 'working' | 'waiting_for_user' | 'idle') {
    useAppStore.getState().applySessionEvent({ type: 'status', sessionId: hydrationSessionId, status })
  },
  reviseMeasuredProgress(boardProgress: number) {
    useAppStore.setState(state => {
      const execution = state.executions[hydrationSessionId]
      const id = execution.currentTurnId!
      const turn = { ...execution.turns[id], boardProgress }
      return { executions: { ...state.executions, [hydrationSessionId]: { ...execution, turns: { ...execution.turns, [id]: turn } } } }
    })
  },
  currentModel: deepSeekModel,
  currentThinkingLevel: 'auto',
  sentImages: [] as Array<{ data: string; mimeType: string }>,
  finishImageTest() {
    const state = useAppStore.getState()
    state.setBusy(current.id, false)
    state.setMessages(current.id, [])
    state.setSessionError(current.id, null)
  },
  thinkingSelections: [] as Array<{ sessionId: string; level: SessionThinkingSelection }>,
  reset() { fixture.commits = 0; fixture.renderMs = 0; fixture.backgroundUpdates = 0 },
  async updateBackground() {
    for (let i = 0; i < 200; i++) {
      const id = `background-${i}`
      useAppStore.getState().setSessionTitle(id, `Background changed ${i}`)
      useAppStore.getState().setSessions(useAppStore.getState().sessions.map(session => session.id === id ? { ...session, status: 'error' } : session))
      await new Promise(requestAnimationFrame)
      fixture.backgroundUpdates += 1
    }
  },
  renameCurrent() { useAppStore.getState().setSessionTitle('current', 'Renamed current conversation') },
  openIdleConversation() {
    const idle = { ...current, id: hydrationSessionId, title: 'Idle conversation' }
    useAppStore.setState(state => ({ currentSessionId: idle.id, sessions: [idle, ...state.sessions] }))
  },
  returnToConversation() {
    transcriptReady = true
    window.dispatchEvent(new Event('focus'))
  },
  updateCurrentStatus() { useAppStore.getState().setSessions(useAppStore.getState().sessions.map(session => session.id === 'current' ? { ...session, status: 'error' } : session)) },
  updatePermission() { useAppStore.getState().setSessions(useAppStore.getState().sessions.map(session => session.id === 'current' ? { ...session, readonly: true } : session)) },
  addMessage() { useAppStore.getState().addMessage('current', { id: 'synthetic-message', role: 'user', content: 'Synthetic current message' }) },
  showError() { useAppStore.getState().setSessionError('current', 'chat.sendFailed') },
  showStopError() {
    useAppStore.getState().setBusy('current', true)
    useAppStore.getState().setSessionError('current', 'chat.stopFailed')
  },
  thinkingTimerCount: () => thinkingTimers.size,
  showRestoredThinking() {
    const state = useAppStore.getState()
    state.setBusy('current', false)
    state.setMessages('current', Array.from({ length: 40 }, (_, index) => [
      { id: `history-user-${index}`, role: 'user' as const, content: `Restored prompt ${index}` },
      { id: `history-assistant-${index}`, role: 'assistant' as const, content: `Restored response ${index}`, thinking: 'Restored reasoning' }
    ]).flat())
  },
  streamThinking() {
    const state = useAppStore.getState()
    state.addMessage('current', { id: 'live-question', role: 'user', content: 'Live prompt' })
    state.setBusy('current', true)
    state.appendThinking('current', 'Live reasoning')
  },
  interruptThinking() { useAppStore.getState().applySessionEvent({ type: 'closed', sessionId: 'current' }) },
  startBoardStream() {
    const state = useAppStore.getState()
    useAppStore.setState({ thinkingAutoExpand: true, thinkingCollapseTiming: 'on-complete' })
    state.addMessage('current', { id: 'board-stream-question', role: 'user', content: 'Check this board' })
    state.setBusy('current', true)
    state.applySessionEvent({ type: 'thinking', sessionId: 'current', delta: 'Synthetic board reasoning begins' })
  },
  growBoardThinking() {
    const state = useAppStore.getState()
    for (let line = 1; line <= 24; line++) {
      state.applySessionEvent({ type: 'thinking', sessionId: 'current', delta: `\nSynthetic board reasoning line ${line}` })
    }
  },
  startBoardTool() {
    useAppStore.getState().applySessionEvent({ type: 'tool_call', sessionId: 'current', id: 'synthetic-board-check', tool: 'toushou_board_check', input: {} })
  },
  continueBoardThinking() {
    useAppStore.getState().applySessionEvent({ type: 'thinking', sessionId: 'current', delta: 'Synthetic follow-up reasoning' })
  },
  showBoardPunctuation() {
    useAppStore.getState().applySessionEvent({ type: 'message', sessionId: 'current', role: 'assistant', content: '.' })
  },
  endBoardStream() {
    useAppStore.getState().applySessionEvent({ type: 'status', sessionId: 'current', status: 'idle', isTerminal: true })
  },
  activityCommits: 0,
  messageListCommits: 0,
  resetProjectionCounters() { fixture.activityCommits = 0; fixture.messageListCommits = 0 },
  startProjectionProbe() {
    useAppStore.setState(state => ({
      busy: { ...state.busy, [probeSessionId]: true },
      executions: {
        ...state.executions,
        [probeSessionId]: foldExecutionEvent(emptyProjection(), { type: 'status', sessionId: probeSessionId, status: 'working' }, 1000)
      }
    }))
  },
  async streamProbeMessages(label: string, count: number) {
    for (let index = 0; index < count; index++) {
      useAppStore.setState(state => ({
        executions: {
          ...state.executions,
          [probeSessionId]: foldExecutionEvent(state.executions[probeSessionId], {
            type: 'message', sessionId: probeSessionId, role: 'assistant', content: `${label} ${index}`
          })
        }
      }))
      await new Promise(requestAnimationFrame)
    }
  },
  startProbeAgent() {
    useAppStore.setState(state => ({
      executions: {
        ...state.executions,
        [probeSessionId]: foldExecutionEvent(state.executions[probeSessionId], {
          type: 'subagent', sessionId: probeSessionId, id: 'probe-agent', agent: 'Probe worker',
          agentSource: 'bundled', status: 'running', parentToolCallId: 'projection-probe-tool'
        })
      }
    }))
  },
  endProjectionProbe() {
    useAppStore.setState(state => ({
      busy: { ...state.busy, [probeSessionId]: false },
      executions: {
        ...state.executions,
        [probeSessionId]: foldExecutionEvent(state.executions[probeSessionId], {
          type: 'status', sessionId: probeSessionId, status: 'idle', isTerminal: true
        }, 3500)
      }
    }))
  },
  recoveryCalls: [] as string[],
  showUnavailableDefault() {
    useProjects.setState({ projects: [{ ...defaultProject }], loaded: true, loading: false, pending: null, error: null, errorProjectId: null })
    useAppStore.getState().setCurrentWorkspace(null)
  },
  recoverySnapshot() { return { calls: fixture.recoveryCalls, workspace: useAppStore.getState().currentWorkspace?.realPath, source: useAppStore.getState().currentWorkspace?.source, missing: useProjects.getState().projects.find(project => project.id === defaultProject.id)?.missing } },
  prepareComposer() {
    const state = useAppStore.getState()
    state.setComposerDraft(current.id, { text: 'Review', images: [] })
    state.setComposerDraft(reviewSessionId, { text: 'Second draft', images: [] })
    useAppStore.setState({ currentSessionId: current.id })
  },
  skillRequested: () => Boolean(resolveSkill),
  finishReadingSkill() {
    resolveSkill?.({ ok: true, entry: skill, content: 'Check synthetic CPI' })
    resolveSkill = undefined
  },
  switchComposerSession() { useAppStore.setState({ currentSessionId: reviewSessionId }) },
  composerDrafts() {
    const { composerDrafts } = useAppStore.getState()
    return { first: composerDrafts[current.id]?.text, second: composerDrafts[reviewSessionId]?.text }
  }
}
declare global { interface Window { chatPerfFixture: typeof fixture } }
window.chatPerfFixture = fixture
window.electronAPI = {
  selectComposerAttachment: async () => ({ ok: true, name: 'pixel.png', mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9+v6kAAAAASUVORK5CYII=' }),
  sendMessage: async (_id: string, _text: string, images: Array<{ data: string; mimeType: string }>) => {
    fixture.sentImages = images
    return true
  },
  listCommands: async () => [], getModelConfig: async () => ({ defaultThinkingLevel: 'auto' }), listModels: async () => [],
  listLaunchableTools: (mode?: string) => mode === 'enabled-plugins'
    ? pluginCatalogReady.then(() => [{ id: 'plugin:reports', label: 'Report extension', command: null, origin: 'installed' }])
    : new Promise(() => undefined),
  listBundledSkills: () => new Promise(() => undefined),
  listSkills: async () => ({ ok: true, entries: [skill] }),
  readSkill: () => new Promise<SkillReadResult>((resolve) => { resolveSkill = resolve }),
  mcpList: async () => [{ enabled: true, name: 'synthetic-ads' }],
  dingTalkStatus: async () => ({ status: 'connected' }),
  listProjectFiles: async () => [],
  setComposerDrafts: async () => true,
  runtimeListModels: async () => [{ ...deepSeekModel, reasoning: false, thinking: [] }, mediumOnlyModel, plainModel],
  getSessionState: async (sessionId: string): Promise<SessionState | null> => {
    if (sessionId !== current.id) return null
    const { provider, id, name, reasoning, thinking } = fixture.currentModel
    return {
      sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0, messageCount: 0,
      model: { provider, id, name }, modelThinking: { reasoning, thinking }, thinkingLevel: fixture.currentThinkingLevel
    }
  },
  setSessionModel: async (sessionId: string, provider: string, modelId: string) => {
    const model = fixtureModels.find(item => item.provider === provider && item.id === modelId)
    if (sessionId !== current.id || !model) return false
    fixture.currentModel = model
    fixture.currentThinkingLevel = 'off'
    const state = useAppStore.getState()
    state.applySessionEvent({ type: 'thinking_level_changed', sessionId, level: 'off' })
    state.applySessionEvent({ type: 'model_changed', sessionId })
    return true
  },
  setThinkingLevel: async (sessionId: string, level: SessionThinkingSelection) => {
    if (sessionId !== current.id) return false
    fixture.thinkingSelections.push({ sessionId, level })
    fixture.currentThinkingLevel = level
    useAppStore.getState().applySessionEvent({ type: 'thinking_level_changed', sessionId, level })
    return true
  },
  sessionTranscript: async (id: string) => id !== hydrationSessionId ? [] : transcriptReady
    ? [{ id: 'idle-history', role: 'assistant', content: 'Recovered the existing conversation' }]
    : null,
  gitInfo: async () => null,
  compactSession: async () => {
    fixture.compactCalls++
    const event = { type: 'compaction', sessionId: current.id, source: 'manual' } as const
    useAppStore.getState().applySessionEvent({ ...event, phase: 'start' })
    await new Promise<void>(resolve => { resolveManualCompact = resolve })
    resolveManualCompact = undefined
    useAppStore.getState().applySessionEvent({ ...event, phase: 'end', outcome: 'compacted' })
    return true
  },
  getSessionStats: async () => ({
    userMessages: 1, assistantMessages: 1, toolCalls: 0, cost: 0,
    tokens: { input: 352000, output: 6500, cacheRead: 0, cacheWrite: 0, total: 358500 },
    contextUsage: { tokens: fixture.compactCalls ? 350 : 120000, contextWindow: 200000, percent: null }
  }),
  setStore: async () => undefined,
  checkpointList: async () => [],
  listProjects: async () => [{ ...defaultProject }], listRecentWorkspaces: async () => [],
  recoverProject: async (id: string) => { fixture.recoveryCalls.push(id); defaultProject.missing = false; delete defaultProject.unavailableReason; return { ok: true, project: { ...defaultProject }, grant: defaultGrant } }
} as unknown as typeof window.electronAPI
useAppStore.setState({ language: 'en', currentWorkspace: { id: 'grant', realPath: current.cwd, displayPath: current.cwd, source: 'dialog', createdAt: 1 }, currentSessionId: 'current', sessions, sessionRecords: [], messages: {}, busy: {}, sessionErrors: {}, uiRequests: {}, cliAvailable: true, runtimeOverview })
createRoot(document.getElementById('root')!).render(<MemoryRouter><Profiler id="actual-chat-panel" onRender={(_id, _phase, duration) => { fixture.commits += 1; fixture.renderMs += duration }}><ChatPanel /></Profiler></MemoryRouter>)
const probeRoot = document.createElement('div')
probeRoot.hidden = true
probeRoot.id = 'projection-probe'
document.body.appendChild(probeRoot)
createRoot(probeRoot).render(<MemoryRouter>
  <div id="projection-probe-activity"><Profiler id="execution-activity" onRender={() => { fixture.activityCommits += 1 }}>
    <ExecutionActivity sessionId={probeSessionId} />
  </Profiler></div>
  <div id="projection-probe-messages"><Profiler id="message-list" onRender={() => { fixture.messageListCommits += 1 }}>
    <MessageList sessionId={probeSessionId} messages={probeMessages} />
  </Profiler></div>
</MemoryRouter>)
