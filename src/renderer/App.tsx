import { Component, Suspense, lazy, type ErrorInfo, type ReactNode, useEffect, useState } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { HistorySessionDescriptor, SessionEvent } from '@shared/types'
import { useAppStore } from './store'
import { useT } from './i18n'
import { useWindowDropGuard } from './lib/useWindowDropGuard'
import { basename } from './lib/path'
import { showNotice } from './lib/notice'
import Layout from './components/Layout'
import CommandPalette, { type CommandPaletteHandlers } from './components/CommandPalette'
import ChatPage from './pages/ChatPage'
import SetupWizard from './pages/SetupWizard'

// Route-level code splitting: ChatPage stays in the initial chunk (first
// screen); every secondary page loads on first navigation. WorkspacePanel
// still imports OfficePage/BrowserPage synchronously, so those two chunks
// mainly dedupe — the heavy Office deps load on demand inside OfficePage.
const PackagesPage = lazy(() => import('./pages/PackagesPage'))
const PluginAuthorPage = lazy(() => import('./pages/PluginAuthorPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const BoardsPage = lazy(() => import('./pages/BoardsPage'))
const BrowserPage = lazy(() => import('./pages/BrowserPage'))
const OfficePage = lazy(() => import('./pages/OfficePage'))
const SkillsPage = lazy(() => import('./pages/SkillsPage'))
const ConnectionsPage = lazy(() => import('./pages/ConnectionsPage'))
const TasksPage = lazy(() => import('./pages/TasksPage'))

interface RendererErrorBoundaryProps {
  children: ReactNode
}

interface RendererErrorBoundaryState {
  error: Error | null
}

/** Keep a renderer exception from turning the whole desktop window blank. */
class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { error: null }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[renderer-error]', error, info.componentStack)
    // Land in the main-process file log so user reports are debuggable.
    window.electronAPI.logRendererError(
      `${error.message}\n${info.componentStack ?? ''}`.slice(0, 8_000)
    )
    this.setState({ error })
  }

  render() {
    if (this.state.error) {
      const language = useAppStore.getState().language
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-ink-950 px-6 text-center text-cream">
          <p className="text-sm font-medium">
            {language === 'zh' ? '投手遇到了渲染错误。' : 'TouShou hit a rendering error.'}
          </p>
          <p className="max-w-xl text-xs text-cream-faint">{this.state.error.message}</p>
          <button
            className="rounded-md bg-cream px-3 py-1.5 text-xs text-ink-950"
            onClick={() => window.location.reload()}
          >
            {language === 'zh' ? '重新加载窗口' : 'Reload window'}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function App() {
  // File drags that miss every drop zone must not navigate the window.
  useWindowDropGuard()
  const {
    setupComplete,
    setTheme,
    setLanguage,
    setCliAvailable,
    setSetupComplete,
    applySessionEvent,
    registerSessions,
    setWorkspacePanel
  } = useAppStore(
    useShallow((s) => ({
      setupComplete: s.setupComplete,
      setTheme: s.setTheme,
      setLanguage: s.setLanguage,
      setCliAvailable: s.setCliAvailable,
      setSetupComplete: s.setSetupComplete,
      applySessionEvent: s.applySessionEvent,
      registerSessions: s.registerSessions,
      setWorkspacePanel: s.setWorkspacePanel
    }))
  )
  const t = useT()
  const navigate = useNavigate()

  useEffect(() => {
    window.electronAPI.getStore('theme').then((theme) => {
      setTheme(theme)
    })
    window.electronAPI.getStore('language').then((language) => {
      setLanguage(language)
    })
    window.electronAPI.getStore('permissionMode').then((mode) => {
      useAppStore.getState().setPermissionMode(mode)
    })
    window.electronAPI.getStore('setupComplete').then((complete) => {
      setSetupComplete(complete)
    })
    window.electronAPI.detectCli().then((info) => {
      setCliAvailable(info.available)
    })
    // Runtime-reported settings/auth/model state (profile-aware adapters).
    useAppStore.getState().loadRuntimeOverview()
    useAppStore.getState().loadRuntimeModels()
    window.electronAPI.listPackages().then((packages) => {
      useAppStore.getState().setPackages(packages)
    })
    window.electronAPI.getStore('pinnedSessionIds').then((ids) => {
      useAppStore.getState().setPinnedSessionIds(ids ?? [])
    })
    window.electronAPI.getStore('archivedSessionIds').then((ids) => {
      useAppStore.getState().setArchivedSessionIds(ids ?? [])
    })

    const syncLiveSessions = () => {
      void window.electronAPI.listSessions().then(registerSessions)
    }
    // Main is authoritative for the in-memory live registry. This also
    // covers a renderer reload and closes the race where a connected event
    // arrives before the create-session response is committed locally.
    syncLiveSessions()
    // Load scheduled tasks and subscribe to state changes from Main.
    window.electronAPI.listTasks().then(useAppStore.getState().setScheduledTasks)
    window.electronAPI.onTasksStateChanged(useAppStore.getState().setScheduledTasks)

    // Micro-batch streaming text: consecutive assistant message/thinking
    // deltas coalesce inside a 32ms window (one store write + render per
    // batch instead of one per token). Any other event flushes the batch
    // first, so global event order — and thus transcript order — stays exact.
    let pendingDeltas: SessionEvent[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flushDeltas = () => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (pendingDeltas.length === 0) return
      const batch = pendingDeltas
      pendingDeltas = []
      const merged: SessionEvent[] = []
      for (const event of batch) {
        const last = merged[merged.length - 1]
        if (
          last &&
          last.type === 'message' &&
          event.type === 'message' &&
          last.role === 'assistant' &&
          event.role === 'assistant' &&
          last.sessionId === event.sessionId
        ) {
          last.content += event.content
        } else if (
          last &&
          last.type === 'thinking' &&
          event.type === 'thinking' &&
          last.sessionId === event.sessionId
        ) {
          last.delta += event.delta
        } else {
          merged.push({ ...event })
        }
      }
      for (const event of merged) applySessionEvent(event)
    }

    const onEvent = (event: SessionEvent) => {
      const isDelta =
        (event.type === 'message' && event.role === 'assistant') || event.type === 'thinking'
      if (!isDelta) {
        flushDeltas()
        applySessionEvent(event)
        if (event.type === 'connected') syncLiveSessions()
        return
      }
      pendingDeltas.push(event)
      if (pendingDeltas.length >= 64) {
        flushDeltas()
      } else if (flushTimer === null) {
        flushTimer = setTimeout(flushDeltas, 32)
      }
    }

    const unsubscribe = window.electronAPI.onSessionEvent(onEvent)

    // Sessions created outside the GUI (Feishu chat routes) announce
    // themselves so the sidebar gets a clickable live row immediately.
    const unsubscribeExternal = window.electronAPI.onExternalSession(
      useAppStore.getState().registerExternalSession
    )

    // Native login flow state (Settings → Authentication)
    const unsubscribeLogin = window.electronAPI.onLoginState((loginState) => {
      useAppStore.setState({ loginState })
      if (
        loginState.status === 'connected' ||
        loginState.status === 'failed' ||
        loginState.status === 'cancelled'
      ) {
        // The flow settled: auth state and model availability may have
        // changed — refresh everything the runtime reports.
        void useAppStore.getState().loadRuntimeOverview(true)
        void useAppStore.getState().loadRuntimeModels()
        void useAppStore.getState().loadModelState()
      }
    })

    // Clicking a completion notification focuses that session's chat
    const unsubscribeNotify = window.electronAPI.onNotifySelectSession((sessionId) => {
      const state = useAppStore.getState()
      if (state.sessions.some((s) => s.id === sessionId)) {
        state.setCurrentSessionId(sessionId)
        navigate('/')
      }
    })

    // Runtime extensions can ask to open an in-app panel (validated in Main).
    const unsubscribePanelOpen = window.electronAPI.onPanelOpen((request) => {
      if (request.panel === 'browser' && request.url) {
        setWorkspacePanel({ kind: 'browser', url: request.url })
        if (window.location.hash !== '#/' && !window.location.hash.startsWith('#/?')) navigate('/')
      } else if (request.panel === 'office' && request.office) {
        setWorkspacePanel({
          kind: 'office',
          grant: request.office.grant,
          name: request.office.name
        })
        if (window.location.hash !== '#/' && !window.location.hash.startsWith('#/?')) navigate('/')
      }
    })

    return () => {
      flushDeltas()
      unsubscribe()
      unsubscribeExternal()
      unsubscribeNotify()
      unsubscribeLogin()
      unsubscribePanelOpen()
    }
  }, [setTheme, setLanguage, setCliAvailable, setSetupComplete, applySessionEvent, registerSessions, setWorkspacePanel, navigate])

  // ⌘N goes home with a clean composer from anywhere. No session is created
  // up front — the first sent message creates it (same as the 对话 nav row).
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setPaletteOpen(false)
        useAppStore.getState().setCurrentSessionId(null)
        navigate('/')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate])

  // ⌘K / Ctrl+K toggles the global command palette from anywhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      if (e.shiftKey || e.altKey || e.repeat) return
      if (e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      setPaletteOpen((open) => !open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // --- command palette execution handlers ----------------------------------
  /**
   * Resume a durable history capability — the palette's mirror of the
   * sidebar's resume flow: prefer the richer history title over the
   * project-dir title Main assigns, fold historical agents into the
   * projection, and retire the opaque history row once a live row exists.
   */
  const resumeHistoryDescriptor = async (info: HistorySessionDescriptor): Promise<boolean> => {
    const state = useAppStore.getState()
    const grant = state.currentWorkspace
    if (!grant || state.historyLoading) return false
    const result = await window.electronAPI.resumeSession(grant.id, info.id)
    if (!result) {
      showNotice('history.restoreFailed')
      // Dead rows (rewritten/removed files) must vanish instead of lingering.
      void state.loadHistorySessions(state.currentWorkspace?.id ?? null)
      void state.loadAllHistorySessions()
      return false
    }
    const { session, messages: restored, historicalAgents } = result
    const projectName = basename(grant.displayPath)
    const title =
      (!session.title || session.title === projectName) && info.title !== 'Untitled'
        ? info.title
        : session.title
    state.addSession({ ...session, title })
    state.setMessages(session.id, restored)
    state.removeHistorySession(info.id)
    state.applyHistoricalAgents(session.id, historicalAgents ?? [])
    state.setCurrentSessionId(session.id)
    navigate('/')
    return true
  }

  /**
   * Open a durable history row by uuid — same flow as the sidebar's
   * cross-project rows: resume in place for the current project, otherwise
   * activate that project first (recent workspaces are the only trusted
   * grant source) and resume there.
   */
  const openHistoryRecord = async (target: { uuid: string; cwd: string }) => {
    const state = useAppStore.getState()
    if (state.historyLoading) return
    const resumeByUuid = async (): Promise<boolean> => {
      await state.loadHistorySessions(state.currentWorkspace?.id ?? null)
      const match = useAppStore
        .getState()
        .sessionRecords.find((r) => !r.isLive && r.history?.uuid === target.uuid)
      if (!match?.history) return false
      return resumeHistoryDescriptor(match.history)
    }

    if (state.currentWorkspace && target.cwd === state.currentWorkspace.realPath) {
      if (await resumeByUuid()) return
      return
    }

    const workspace = state.recentWorkspaces.find(
      (entry) => basename(entry.displayPath) === basename(target.cwd)
    )
    if (!workspace) {
      showNotice('sidebar.projectNotAdded')
      return
    }
    await state.activateRecentWorkspace(workspace.id)
    const activated = useAppStore.getState().currentWorkspace
    if (!activated || activated.realPath !== target.cwd) {
      showNotice('sidebar.projectNotAdded')
      return
    }
    if (await resumeByUuid()) return
    showNotice('sidebar.projectSwitched')
  }

  const paletteHandlers: CommandPaletteHandlers = {
    navigate: (path) => navigate(path),
    // Same flow as the sidebar 对话 row and ⌘N: clear the selection; the
    // session is created by the first message.
    newChat: () => {
      setPaletteOpen(false)
      useAppStore.getState().setCurrentSessionId(null)
      navigate('/')
    },
    toggleTheme: () => {
      const state = useAppStore.getState()
      state.setTheme(state.theme === 'dark' ? 'light' : 'dark')
    },
    exportHtml: (sessionId) => {
      void window.electronAPI.exportHtml(sessionId).then((saved) => {
        // Quiet success (ChatPanel owns the inline path chip); a failed
        // export must not look like a silent no-op.
        if (saved) showNotice('palette.exportSaved')
        else showNotice('palette.exportFailed')
      })
    },
    openSession: (sessionId) => {
      useAppStore.getState().setCurrentSessionId(sessionId)
      navigate('/')
    },
    openHistory: (target) => {
      void openHistoryRecord(target)
    }
  }

  if (setupComplete === null) {
    // Settings not loaded yet — avoid flashing the setup wizard
    return (
      <div className="flex h-full items-center justify-center bg-ink-950 text-sm text-cream-faint">
        {t('app.loading')}
      </div>
    )
  }

  if (!setupComplete) {
    return <SetupWizard />
  }

  return (
    <RendererErrorBoundary>
      <Layout>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center bg-ink-950 text-sm text-cream-faint">
              {t('app.loading')}
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/plugins" element={<PackagesPage />} />
            <Route path="/plugins/new" element={<PluginAuthorPage />} />
            <Route path="/boards" element={<BoardsPage />} />
            <Route path="/browser" element={<BrowserPage />} />
            <Route path="/office" element={<OfficePage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/tasks" element={<TasksPage />} />
          </Routes>
        </Suspense>
      </Layout>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        handlers={paletteHandlers}
      />
    </RendererErrorBoundary>
  )
}

export default App
