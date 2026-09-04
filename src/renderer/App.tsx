import { Component, Suspense, lazy, type ErrorInfo, type ReactNode, useEffect } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { SessionEvent } from '@shared/types'
import { useAppStore } from './store'
import { useT } from './i18n'
import Layout from './components/Layout'
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
    this.setState({ error })
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-ink-950 px-6 text-center text-cream">
          <p className="text-sm font-medium">投手遇到了渲染错误。</p>
          <p className="max-w-xl text-xs text-cream-faint">{this.state.error.message}</p>
          <button
            className="rounded-md bg-cream px-3 py-1.5 text-xs text-ink-950"
            onClick={() => window.location.reload()}
          >
            重新加载窗口
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function App() {
  const {
    setupComplete,
    setTheme,
    setLanguage,
    setCliAvailable,
    setSetupComplete,
    applySessionEvent,
    registerSessions,
    setWorkspacePanel,
    setRightPanelOpen
  } = useAppStore(
    useShallow((s) => ({
      setupComplete: s.setupComplete,
      setTheme: s.setTheme,
      setLanguage: s.setLanguage,
      setCliAvailable: s.setCliAvailable,
      setSetupComplete: s.setSetupComplete,
      applySessionEvent: s.applySessionEvent,
      registerSessions: s.registerSessions,
      setWorkspacePanel: s.setWorkspacePanel,
      setRightPanelOpen: s.setRightPanelOpen
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
        setRightPanelOpen(false)
        setWorkspacePanel({ kind: 'browser', url: request.url })
        if (window.location.hash !== '#/' && !window.location.hash.startsWith('#/?')) navigate('/')
      } else if (request.panel === 'office' && request.office) {
        setRightPanelOpen(false)
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
      unsubscribeNotify()
      unsubscribeLogin()
      unsubscribePanelOpen()
    }
  }, [setTheme, setLanguage, setCliAvailable, setSetupComplete, applySessionEvent, registerSessions, setWorkspacePanel, setRightPanelOpen, navigate])

  // ⌘N goes home with a clean composer from anywhere. No session is created
  // up front — the first sent message creates it (same as the 对话 nav row).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        useAppStore.getState().setCurrentSessionId(null)
        navigate('/')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate])

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
          </Routes>
        </Suspense>
      </Layout>
    </RendererErrorBoundary>
  )
}

export default App
