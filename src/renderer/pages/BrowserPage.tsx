import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, ExternalLink, Loader2, RotateCw, X } from 'lucide-react'
import { BrowserPanelState } from '@shared/types'
import { useT } from '../i18n'

/**
 * In-app browser. The page itself is only a toolbar plus an empty placeholder;
 * the actual web content is a Main-owned WebContentsView layered exactly over
 * the placeholder (bounds mirrored via the browserSetBounds IPC). The panel
 * survives route changes (hide, not destroy), so an extension-triggered open
 * with ?url=… resumes the same browsing session.
 */
export default function BrowserPage() {
  const t = useT()
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

  // Mount-only: show the panel over the placeholder, keep bounds synced, and
  // hide (not destroy) it when the page unmounts. The initial URL is captured
  // once from ?url= so re-renders never retrigger a load.
  const initialUrl = searchParams.get('url')
  useLayoutEffect(() => {
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
    void window.electronAPI.browserShow(readBounds(), initialUrl ?? undefined)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
      void window.electronAPI.browserHide()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // An extension open (or a fresh /browser?url=… navigation) while the page
  // is already mounted must drive the panel — the mount effect alone would
  // keep showing the previously loaded page.
  const lastOpenedUrl = useRef(initialUrl)
  useEffect(() => {
    const target = searchParams.get('url')
    if (target && target !== lastOpenedUrl.current) {
      lastOpenedUrl.current = target
      void window.electronAPI.browserNavigate('go', target)
    }
  }, [searchParams])

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
    void window.electronAPI.browserNavigate('go', withScheme)
    addressRef.current?.blur()
  }, [])

  const closePanel = () => {
    if (window.history.length > 1) navigate(-1)
    else navigate('/')
  }

  const iconButton =
    'shrink-0 rounded-md p-1.5 text-cream-dim transition-colors hover:bg-overlay hover:text-cream disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-cream-dim'

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-950">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <button
          className={iconButton}
          disabled={!panelState.canGoBack}
          onClick={() => void window.electronAPI.browserNavigate('back')}
          title={t('browser.back')}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          className={iconButton}
          disabled={!panelState.canGoForward}
          onClick={() => void window.electronAPI.browserNavigate('forward')}
          title={t('browser.forward')}
        >
          <ArrowRight size={15} />
        </button>
        <button
          className={iconButton}
          onClick={() => void window.electronAPI.browserNavigate('reload')}
          title={t('browser.reload')}
        >
          {panelState.loading ? <Loader2 size={15} className="animate-spin" /> : <RotateCw size={15} />}
        </button>
        <input
          ref={addressRef}
          className="min-w-0 flex-1 rounded-md border border-line bg-ink-800 px-3 py-1 text-[13px] text-cream outline-none transition-colors placeholder:text-cream-faint focus:border-accent/50"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(address)
          }}
          placeholder={t('browser.addressPlaceholder')}
          spellCheck={false}
        />
        <button
          className={iconButton}
          disabled={!panelState.url}
          onClick={() => void window.electronAPI.openExternalUrl(panelState.url)}
          title={t('browser.openExternal')}
        >
          <ExternalLink size={15} />
        </button>
        <button className={iconButton} onClick={closePanel} title={t('browser.close')}>
          <X size={15} />
        </button>
      </div>
      {/* The native WebContentsView renders exactly over this placeholder. */}
      <div ref={placeholderRef} className="min-h-0 flex-1 bg-ink-950" />
    </div>
  )
}
