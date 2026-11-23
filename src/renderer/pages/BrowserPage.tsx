import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, ExternalLink, Globe2, Loader2, MessageSquareText, RotateCw, X } from 'lucide-react'
import { BrowserPanelState } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { useBrowserSuspendedForModal } from '../lib/modalBoundary'

/**
 * In-app browser. The page itself is only a toolbar plus an empty placeholder;
 * the actual web content is a Main-owned WebContentsView layered exactly over
 * the placeholder (bounds mirrored via the browserSetBounds IPC). The panel
 * survives route changes (hide, not destroy), so an extension-triggered open
 * with ?url=… resumes the same browsing session.
 */
interface BrowserPageProps {
  embedded?: boolean
  active?: boolean
  initialUrl?: string
  onClose?: () => void
}

export default function BrowserPage({ embedded = false, active = true, initialUrl: requestedInitialUrl, onClose }: BrowserPageProps) {
  const t = useT()
  const suspended = useBrowserSuspendedForModal()
  const shownOnce = useRef(false)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const placeholderRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const [address, setAddress] = useState('')
  const [panelState, setPanelState] = useState<BrowserPanelState>({
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false
  })
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    },
    []
  )

  const flashToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2500)
  }, [])

  // Mount-only: show the panel over the placeholder, keep bounds synced, and
  // hide (not destroy) it when the page unmounts. The initial URL is captured
  // once from ?url= so re-renders never retrigger a load.
  const routeUrl = embedded ? null : searchParams.get('url')
  const initialUrl = routeUrl ?? requestedInitialUrl
  useLayoutEffect(() => {
    if (!active || suspended) {
      void window.electronAPI.browserHide()
      return
    }
    const el = placeholderRef.current
    if (!el) return
    const readBounds = () => {
      const rect = el.getBoundingClientRect()
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    }
    const syncBounds = () => {
      void window.electronAPI.browserSetBounds(readBounds())
    }
    const observer = new ResizeObserver(syncBounds)
    observer.observe(el)
    window.addEventListener('resize', syncBounds)
    const url = shownOnce.current ? undefined : initialUrl ?? undefined
    shownOnce.current = true
    void window.electronAPI.browserShow(readBounds(), url)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
      void window.electronAPI.browserHide()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, suspended])

  // An extension open (or a fresh /browser?url=… navigation) while the page
  // is already mounted must drive the panel — the mount effect alone would
  // keep showing the previously loaded page.
  const previousRequests = useRef({ requestedInitialUrl, routeUrl })
  useEffect(() => {
    const previous = previousRequests.current
    previousRequests.current = { requestedInitialUrl, routeUrl }
    const target = routeUrl && routeUrl !== previous.routeUrl
      ? routeUrl
      : requestedInitialUrl !== previous.requestedInitialUrl ? requestedInitialUrl : undefined
    if (target) void window.electronAPI.browserNavigate('go', target)
  }, [requestedInitialUrl, routeUrl])

  // Main pushes navigation state; keep the toolbar in sync. While the address
  // input is focused, don't yank the user's in-progress edit away.
  useEffect(() => {
    return window.electronAPI.onBrowserState((state) => {
      setPanelState(state)
      if (document.activeElement !== addressRef.current) {
        setAddress(state.url)
      }
    })
  }, [])

  const go = useCallback((raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
    addressRef.current?.blur()
    void window.electronAPI.browserNavigate('go', withScheme).then((result) => {
      if (!result.ok) flashToast(t(result.error === 'invalid-url' ? 'browser.invalidAddress' : 'browser.openFailed'))
    }).catch(() => flashToast(t('browser.openFailed')))
  }, [flashToast, t])

  const closePanel = () => {
    if (onClose) {
      onClose()
      return
    }
    if (window.history.length > 1) navigate(-1)
    else navigate('/')
  }

  /** Append the current page (title + URL) to the chat composer draft. */
  const sendPageToAgent = () => {
    if (!panelState.url) return
    const title = panelState.title.trim()
    const pageRef = title ? `${title}\n${panelState.url}` : panelState.url
    const store = useAppStore.getState()
    const existing = store.currentSessionId ? store.composerDrafts[store.currentSessionId]?.text.trim() : ''
    store.setComposerPrefill(existing ? `${existing}\n\n${pageRef}` : pageRef)
    flashToast(t('browser.contextReady'))
    navigate('/')
  }

  const iconButton =
    'focus-ring shrink-0 rounded-md p-1.5 text-cream-dim transition-colors hover:bg-overlay hover:text-cream disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-cream-dim'

  return (
    <div className={`relative flex h-full min-h-0 flex-col bg-ink-950 ${embedded ? 'w-full' : ''}`}>
      <div role="group" aria-label={t('home.quick.browser')} className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <button
          className={iconButton}
          disabled={!panelState.canGoBack}
          onClick={() => void window.electronAPI.browserNavigate('back')}
          title={t('browser.back')}
          aria-label={t('browser.back')}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          className={iconButton}
          disabled={!panelState.canGoForward}
          onClick={() => void window.electronAPI.browserNavigate('forward')}
          title={t('browser.forward')}
          aria-label={t('browser.forward')}
        >
          <ArrowRight size={15} />
        </button>
        <button
          className={iconButton}
          onClick={() => void window.electronAPI.browserNavigate('reload')}
          title={t('browser.reload')}
          aria-label={t('browser.reload')}
          aria-busy={panelState.loading}
        >
          {panelState.loading ? <Loader2 size={15} className="animate-spin" /> : <RotateCw size={15} />}
        </button>
        <input
          ref={addressRef}
          className="min-w-0 flex-1 rounded-md border border-line bg-ink-800 px-3 py-1 text-[13px] text-cream outline-none transition-colors placeholder:text-cream-faint focus:border-accent/50"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter') go(address)
          }}
          aria-label={t('browser.addressPlaceholder')}
          placeholder={t('browser.addressPlaceholder')}
          spellCheck={false}
        />
        <button
          className={iconButton}
          disabled={!panelState.url}
          onClick={sendPageToAgent}
          title={t('browser.askAgent')}
          aria-label={t('browser.askAgent')}
        >
          <MessageSquareText size={15} />
        </button>
        <button
          className={iconButton}
          disabled={!panelState.url}
          onClick={() => void window.electronAPI.openExternalUrl(panelState.url)}
          title={t('browser.openExternal')}
          aria-label={t('browser.openExternal')}
        >
          <ExternalLink size={15} />
        </button>
        {/* Embedded: the workspace panel's tab row owns the close control. */}
        {!embedded && (
          <button className={iconButton} onClick={closePanel} title={t('browser.close')} aria-label={t('browser.close')}>
            <X size={15} />
          </button>
        )}
      </div>
      {/* The native WebContentsView renders exactly over this placeholder. */}
      <div ref={placeholderRef} className="relative min-h-0 flex-1 bg-ink-950">
        {/* Honest empty state until a page is loaded (design.md 2.1). */}
        {!panelState.url && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-8 text-center">
            <Globe2 size={26} className="text-cream-faint" aria-hidden="true" />
            <p role="status" className="text-[13px] text-cream-dim">{t(panelState.loading ? 'browser.loading' : 'browser.emptyState')}</p>
          </div>
        )}
      </div>
      {/* Anchored to the toolbar strip: everything below it is covered by the
          native WebContentsView, which would hide a lower toast. */}
      {toast && (
        <div role="status" className="fade-in pointer-events-none absolute left-1/2 top-1.5 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-ink-900 px-3 py-1 shadow-pop">
          <span className="text-[12px] text-cream">{toast}</span>
        </div>
      )}
    </div>
  )
}
