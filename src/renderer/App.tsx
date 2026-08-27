import { Component, type ErrorInfo, type ReactNode, useEffect } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { useAppStore } from './store'
import { useT } from './i18n'
import { createSessionForCurrentProject } from './lib/session'
import Layout from './components/Layout'
import ChatPage from './pages/ChatPage'
import PackagesPage from './pages/PackagesPage'
import PluginAuthorPage from './pages/PluginAuthorPage'
import SettingsPage from './pages/SettingsPage'
import BoardsPage from './pages/BoardsPage'
import SetupWizard from './pages/SetupWizard'

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
          <p className="text-sm font-medium">投手 encountered a rendering error.</p>
          <p className="max-w-xl text-xs text-cream-faint">{this.state.error.message}</p>
          <button
            className="rounded-md bg-cream px-3 py-1.5 text-xs text-ink-950"
            onClick={() => window.location.reload()}
          >
            Reload window
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
    registerSessions
  } = useAppStore()
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

    const unsubscribe = window.electronAPI.onSessionEvent((event) => {
      applySessionEvent(event)
      if (event.type === 'connected') syncLiveSessions()
    })

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

    return () => {
      unsubscribe()
      unsubscribeNotify()
      unsubscribeLogin()
    }
  }, [setTheme, setLanguage, setCliAvailable, setSetupComplete, applySessionEvent, registerSessions, navigate])

  // ⌘N starts a new chat from anywhere
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        // Same guard as the sidebar button: no CLI, no session (SetupWizard).
        if (useAppStore.getState().cliAvailable === false) return
        createSessionForCurrentProject().then((id) => {
          if (id) navigate('/')
        })
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
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/plugins" element={<PackagesPage />} />
          <Route path="/plugins/new" element={<PluginAuthorPage />} />
          <Route path="/boards" element={<BoardsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Layout>
    </RendererErrorBoundary>
  )
}

export default App
