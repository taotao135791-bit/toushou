import { useState, useRef, useMemo, useEffect, ClipboardEvent, KeyboardEvent } from 'react'
import {
  ArrowUp,
  Square,
  Paperclip,
  Image as ImageIcon,
  Zap,
  X,
  File,
  ListPlus,
  Loader2
} from 'lucide-react'
import { PromptImage, SlashCommand } from '@shared/types'
import { QueuedMessage, useAppStore } from '../store'
import { SessionComposerDraft } from '../lib/composerDraft'
import { dispatchSteer, steerFailureKey } from '../lib/steerDispatch'
import { useT } from '../i18n'
import ModelPicker from './ModelPicker'
import ThinkingPicker from './ThinkingPicker'
import PermissionPicker from './PermissionPicker'
import UsageMonitor from './UsageMonitor'

interface ComposerProps {
  /** Delivers the composed text; resolves false when delivery failed and the draft is restored. */
  onSend: (text: string, images?: PromptImage[]) => void | boolean | Promise<void | boolean>
  onStop?: () => void
  busy?: boolean
  disabled?: boolean
  /** Changes whenever the active session changes; used to focus a ready chat. */
  focusKey?: string | null
  /** Abort was requested and the runtime has not confirmed terminal state yet. */
  stopping?: boolean
  /** Slash commands available in the live session (from get_commands). */
  commands?: SlashCommand[]
  /** Built-in /compact action, shown first in the slash menu. */
  onCompact?: () => void
}

type MenuItem = SlashCommand & { builtin?: boolean }

/** An image staged in the composer, riding along with the next send/queue. */
interface PendingImage {
  id: string
  data: string
  mimeType: string
  previewUrl: string
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGES = 4
const MAX_FILE_ITEMS = 20
/** Mirrors the main-process listProjectFiles cache window. */
const FILE_LIST_TTL_MS = 30_000

const EMPTY_QUEUE: QueuedMessage[] = []

const IMAGE_ERROR_KEYS = {
  tooLarge: 'composer.imageTooLarge',
  max: 'composer.maxImages',
  notImage: 'composer.imageNotImage',
  readFailed: 'composer.imageReadFailed'
} as const

function toPromptImages(images: PendingImage[]): PromptImage[] {
  return images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType }))
}

function fromPromptImages(images: PromptImage[]): PendingImage[] {
  return images.map((image) => ({
    id: crypto.randomUUID(),
    data: image.data,
    mimeType: image.mimeType,
    previewUrl: `data:${image.mimeType};base64,${image.data}`
  }))
}

/**
 * The `@token` ending at the caret: `@` must start the input or follow
 * whitespace, and the token itself must contain no whitespace.
 */
function atToken(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query)) return null
  return { query, start: at }
}

export default function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  focusKey,
  stopping = false,
  commands = [],
  onCompact
}: ComposerProps) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const [atMenuIndex, setAtMenuIndex] = useState(0)
  const [atDismissed, setAtDismissed] = useState(false)
  const [images, setImages] = useState<PendingImage[]>([])
  const [steeringQueuedId, setSteeringQueuedId] = useState<string | null>(null)
  const steeringQueuedIdRef = useRef<string | null>(null)
  const [loadedSessionId, setLoadedSessionId] = useState<string | null | undefined>(undefined)
  const [imageError, setImageError] = useState<keyof typeof IMAGE_ERROR_KEYS | null>(null)
  const [projectFiles, setProjectFiles] = useState<string[]>([])
  const filesLoadedAt = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const t = useT()
  const composerPrefill = useAppStore((s) => s.composerPrefill)
  const setComposerPrefill = useAppStore((s) => s.setComposerPrefill)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const setComposerDraft = useAppStore((s) => s.setComposerDraft)
  const clearComposerDraft = useAppStore((s) => s.clearComposerDraft)
  const queue = useAppStore((s) =>
    currentSessionId ? (s.queuedMessages[currentSessionId] ?? EMPTY_QUEUE) : EMPTY_QUEUE
  )
  const enqueueQueuedMessage = useAppStore((s) => s.enqueueQueuedMessage)
  const removeQueuedMessage = useAppStore((s) => s.removeQueuedMessage)
  const reserveQueuedMessage = useAppStore((s) => s.reserveQueuedMessage)

  const writeDraft = (sessionId: string | null, nextText: string, nextImages: PendingImage[]) => {
    if (!sessionId) return
    const draft: SessionComposerDraft = { text: nextText, images: toPromptImages(nextImages) }
    setComposerDraft(sessionId, draft)
  }

  const commitDraft = (nextText: string, nextImages = images) => {
    setText(nextText)
    setImages(nextImages)
    writeDraft(currentSessionId, nextText, nextImages)
  }

  const clearLocalDraft = () => {
    setText('')
    setCaret(0)
    setImages([])
    setImageError(null)
    setMenuDismissed(false)
    setAtDismissed(false)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  // The Composer stays mounted while the selected transcript changes. Hydrate
  // the editing surface from the newly selected session and reset transient UI.
  useEffect(() => {
    textareaRef.current?.blur()
    const draft = currentSessionId ? useAppStore.getState().composerDrafts[currentSessionId] : undefined
    setText(draft?.text ?? '')
    setImages(draft ? fromPromptImages(draft.images) : [])
    setCaret(draft?.text.length ?? 0)
    setMenuIndex(0)
    setMenuDismissed(false)
    setAtMenuIndex(0)
    setAtDismissed(false)
    setImageError(null)
    setLoadedSessionId(currentSessionId)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    })
  }, [currentSessionId])

  // One-shot prefill requested by another page (e.g. "build your own plugin")
  useEffect(() => {
    if (composerPrefill == null) return
    commitDraft(composerPrefill)
    setCaret(composerPrefill.length)
    setComposerPrefill(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    })
  }, [composerPrefill, setComposerPrefill])

  // New Chat and A↔B switching both land on a ready composer. Focus after the
  // session id is committed, so the click that created/switched the session
  // cannot leave keyboard input on the Sidebar button.
  useEffect(() => {
    if (!focusKey || disabled) return
    const frame = requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
    return () => cancelAnimationFrame(frame)
  }, [focusKey, disabled])

  // Transient image-error hint
  useEffect(() => {
    if (!imageError) return
    const timer = setTimeout(() => setImageError(null), 3000)
    return () => clearTimeout(timer)
  }, [imageError])

  // Slash menu is active while the whole input is a single "/partial" token
  const slashQuery = /^\/(\S*)$/.test(text) && !menuDismissed ? text.slice(1).toLowerCase() : null
  const menuItems = useMemo<MenuItem[]>(() => {
    if (slashQuery === null) return []
    const all: MenuItem[] = [
      ...(onCompact
        ? [{ name: 'compact', description: t('composer.slashCompact'), source: 'prompt' as const, builtin: true }]
        : []),
      ...commands
    ]
    return all.filter((c) => c.name.toLowerCase().startsWith(slashQuery)).slice(0, 8)
  }, [slashQuery, commands, onCompact, t])
  const menuOpen = menuItems.length > 0

  // @ file menu: active on a trailing "@token", only with a workspace selected
  const at = useMemo(() => {
    if (!currentWorkspace || atDismissed || slashQuery !== null) return null
    return atToken(text, caret)
  }, [text, caret, currentWorkspace, atDismissed, slashQuery])
  const atOpen = at !== null

  // Fetch the flat project file list when the @ menu opens (main caches 30s)
  useEffect(() => {
    if (!atOpen || !currentWorkspace) return
    if (Date.now() - filesLoadedAt.current < FILE_LIST_TTL_MS) return
    let cancelled = false
    filesLoadedAt.current = Date.now()
    window.electronAPI.listProjectFiles(currentWorkspace.id).then((files) => {
      if (!cancelled) setProjectFiles(files)
    })
    return () => {
      cancelled = true
    }
  }, [atOpen, currentWorkspace])

  useEffect(() => {
    setAtMenuIndex(0)
  }, [at?.query])

  const fileItems = useMemo(() => {
    if (!at) return []
    const q = at.query.toLowerCase()
    const hits = q ? projectFiles.filter((f) => f.toLowerCase().includes(q)) : projectFiles
    // Basename hits first, then shorter paths
    return [...hits]
      .sort((a, b) => {
        if (!q) return 0
        const an = (a.split('/').pop() ?? a).toLowerCase().includes(q) ? 0 : 1
        const bn = (b.split('/').pop() ?? b).toLowerCase().includes(q) ? 0 : 1
        return an - bn || a.length - b.length
      })
      .slice(0, MAX_FILE_ITEMS)
  }, [at, projectFiles])

  /** Replace text[start:end] with insert and place the caret after it. */
  const replaceRange = (start: number, end: number, insert: string) => {
    const next = text.slice(0, start) + insert + text.slice(end)
    const pos = start + insert.length
    commitDraft(next)
    setCaret(pos)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(pos, pos)
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    })
  }

  const pickCommand = (item: MenuItem) => {
    if (item.builtin) {
      commitDraft('')
      setCaret(0)
      onCompact?.()
      return
    }
    const next = `/${item.name} `
    commitDraft(next)
    setCaret(next.length)
    setMenuDismissed(false)
    setMenuIndex(0)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.length, next.length)
    })
  }

  const pickFile = (relPath: string) => {
    if (!at) return
    replaceRange(at.start, caret, `@${relPath} `)
  }

  const addImage = (data: string, mimeType: string) => {
    const sessionIdAtAction = currentSessionId
    setImages((prev) => {
      if (prev.length >= MAX_IMAGES) return prev
      const next = [
        ...prev,
        {
          id: crypto.randomUUID(),
          data,
          mimeType,
          previewUrl: `data:${mimeType};base64,${data}`
        }
      ]
      writeDraft(sessionIdAtAction, text, next)
      return useAppStore.getState().currentSessionId === sessionIdAtAction ? next : prev
    })
  }

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length === 0) return
    e.preventDefault()
    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) {
        setImageError('tooLarge')
        continue
      }
      if (images.length >= MAX_IMAGES) {
        setImageError('max')
        continue
      }
      const mimeType = file.type || 'image/png'
      const reader = new FileReader()
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : ''
        const comma = result.indexOf(',')
        if (comma === -1) return
        addImage(result.slice(comma + 1), mimeType)
      }
      reader.readAsDataURL(file)
    }
  }

  const handlePickImage = async () => {
    if (images.length >= MAX_IMAGES) {
      setImageError('max')
      return
    }
    const res = await window.electronAPI.selectImage()
    if (!res) return
    if (!res.ok) {
      setImageError(res.error)
      return
    }
    addImage(res.data, res.mimeType)
  }

  // 📎: pick any file and reference it as @path at the caret
  const handleAttachFile = async () => {
    const sessionIdAtAction = currentSessionId
    const filePath = await window.electronAPI.selectFile([{ name: 'All Files', extensions: ['*'] }])
    if (!filePath) return
    if (useAppStore.getState().currentSessionId !== sessionIdAtAction) return
    const rel =
      currentWorkspace && filePath.startsWith(`${currentWorkspace.realPath}/`)
        ? filePath.slice(currentWorkspace.realPath.length + 1)
        : filePath
    replaceRange(caret, caret, `@${rel} `)
  }

  const stagedImages = (): PromptImage[] | undefined =>
    images.length
      ? images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))
      : undefined

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    const sessionIdAtSend = currentSessionId
    const imgs = stagedImages()
    if (busy) {
      // Mid-turn: park the message; the store drains the queue on idle.
      if (!currentSessionId) return
      enqueueQueuedMessage(currentSessionId, {
        id: crypto.randomUUID(),
        text: trimmed,
        images: imgs
      })
    } else {
      // The send is async: clear optimistically, but roll the draft back when
      // delivery failed (dead session, invalid grant) so it is never lost.
      const staged = images
      const restore = (ok: void | boolean) => {
        if (ok !== false) return
        const restoreSessionId = sessionIdAtSend ?? useAppStore.getState().currentSessionId
        if (restoreSessionId) {
          setComposerDraft(restoreSessionId, { text: trimmed, images: toPromptImages(staged) })
        }
        if (
          (sessionIdAtSend && useAppStore.getState().currentSessionId !== sessionIdAtSend) ||
          (!sessionIdAtSend && restoreSessionId !== useAppStore.getState().currentSessionId)
        ) {
          return
        }
        setText((cur) => (cur.trim() ? cur : trimmed))
        setImages((cur) => (cur.length ? cur : staged))
        setCaret(trimmed.length)
      }
      if (sessionIdAtSend) clearComposerDraft(sessionIdAtSend)
      if (!sessionIdAtSend || useAppStore.getState().currentSessionId === sessionIdAtSend) {
        clearLocalDraft()
      }
      const result = onSend(trimmed, imgs)
      if (result instanceof Promise) void result.then(restore)
      else restore(result)
      return
    }
    if (sessionIdAtSend) clearComposerDraft(sessionIdAtSend)
    if (!sessionIdAtSend || useAppStore.getState().currentSessionId === sessionIdAtSend) {
      clearLocalDraft()
    }
  }

  // Send a queued message into the running turn right now. The item remains
  // queue-owned until OMP acknowledges the Steer, so a false/rejected RPC
  // cannot silently destroy the user's queued work.
  const handleSteerNow = (m: QueuedMessage) => {
    const sessionId = currentSessionId
    if (!sessionId || steeringQueuedIdRef.current) return
    if (!reserveQueuedMessage(sessionId, m.id)) return
    steeringQueuedIdRef.current = m.id
    setSteeringQueuedId(m.id)

    void dispatchSteer({
      sessionId,
      text: m.text,
      images: m.images,
      source: 'queue',
      steer: (sid, text, imgs) => window.electronAPI.steer(sid, text, imgs)
    })
      .then((result) => {
        const latest = useAppStore.getState()
        if (result.ok) {
          if (!latest.sessions.some((session) => session.id === sessionId)) {
            latest.releaseQueuedMessage(sessionId, m.id)
            return
          }
          latest.removeQueuedMessage(sessionId, m.id)
          latest.addMessage(sessionId, {
            id: crypto.randomUUID(),
            role: 'user',
            kind: 'steer',
            content: m.text,
            images: m.images?.map(({ data, mimeType }) => ({ data, mimeType }))
          })
          // A trajectory fact exists only after OMP accepted the Steer.
          latest.recordSteer(sessionId, m.text)
          latest.setSessionError(sessionId, null)
          return
        }

        latest.releaseQueuedMessage(sessionId, m.id)
        latest.setSessionError(sessionId, steerFailureKey(result.source))
        // If the turn ended while the ACK was pending, release ownership and
        // give the queued item its normal FIFO drain opportunity.
        if (!latest.busy[sessionId]) latest.drainQueuedMessage(sessionId)
      })
      .finally(() => {
        if (steeringQueuedIdRef.current === m.id) {
          steeringQueuedIdRef.current = null
          setSteeringQueuedId(null)
        }
      })
  }

  // Send directly into the active turn. This is deliberately separate from
  // Queue so the user never has to discover the queued-chip Zap action first.
  const handleSteerCurrent = () => {
    const sessionId = currentSessionId
    const trimmed = text.trim()
    if (!sessionId || !trimmed || disabled || !busy) return
    const staged = images
    const imgs = stagedImages()
    const store = useAppStore.getState()
    store.clearComposerDraft(sessionId)
    clearLocalDraft()

    void dispatchSteer({
      sessionId,
      text: trimmed,
      images: imgs,
      source: 'composer',
      steer: (sid, text, images) => window.electronAPI.steer(sid, text, images)
    }).then((result) => {
      const latest = useAppStore.getState()
      if (result.ok) {
        if (!latest.sessions.some((session) => session.id === sessionId)) return
        latest.addMessage(sessionId, {
          id: crypto.randomUUID(),
          role: 'user',
          kind: 'steer',
          content: trimmed,
          images: imgs?.map(({ data, mimeType }) => ({ data, mimeType }))
        })
        // A trajectory fact exists only after OMP accepted the Steer.
        latest.recordSteer(sessionId, trimmed)
        latest.setSessionError(sessionId, null)
        return
      }

      if (!latest.sessions.some((session) => session.id === sessionId)) return
      latest.setComposerDraft(sessionId, { text: trimmed, images: toPromptImages(staged) })
      latest.setSessionError(sessionId, steerFailureKey(result.source))
      if (latest.currentSessionId !== sessionId) return
      setText(trimmed)
      setImages(staged)
      setCaret(trimmed.length)
    })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (atOpen) {
      if (e.key === 'ArrowDown' && fileItems.length > 0) {
        e.preventDefault()
        setAtMenuIndex((i) => (i + 1) % fileItems.length)
        return
      }
      if (e.key === 'ArrowUp' && fileItems.length > 0) {
        e.preventDefault()
        setAtMenuIndex((i) => (i - 1 + fileItems.length) % fileItems.length)
        return
      }
      if (
        (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) &&
        fileItems.length > 0
      ) {
        e.preventDefault()
        pickFile(fileItems[Math.min(atMenuIndex, fileItems.length - 1)])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtDismissed(true)
        return
      }
    }
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMenuIndex((i) => (i + 1) % menuItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMenuIndex((i) => (i - 1 + menuItems.length) % menuItems.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault()
        pickCommand(menuItems[Math.min(menuIndex, menuItems.length - 1)])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuDismissed(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  const canSend = !disabled && Boolean(text.trim())

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="relative mx-auto w-full max-w-3xl">
        {menuOpen && (
          <div className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-line bg-ink-850 p-1 shadow-pop">
            <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-faint">
              {t('composer.slashTitle')}
            </div>
            {menuItems.map((item, i) => (
              <button
                key={`${item.source}-${item.name}`}
                onMouseEnter={() => setMenuIndex(i)}
                onClick={() => pickCommand(item)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  i === menuIndex ? 'bg-overlay-strong' : ''
                }`}
              >
                <Zap size={12} className={item.builtin ? 'shrink-0 text-accent' : 'shrink-0 text-cream-faint'} />
                <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-cream">
                  /{item.name}
                </span>
                {item.description && (
                  <span className="min-w-0 truncate text-[11px] text-cream-faint">
                    {item.description}
                  </span>
                )}
                <span className="ml-auto shrink-0 font-mono text-[9.5px] uppercase tracking-wider text-cream-faint">
                  {item.builtin ? t('composer.slashBuiltin') : item.source}
                </span>
              </button>
            ))}
          </div>
        )}
        {atOpen && (
          <div className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border border-line bg-ink-850 p-1 shadow-pop">
            <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-faint">
              {t('composer.atTitle')}
            </div>
            {fileItems.length === 0 ? (
              <div className="px-2.5 py-2 text-[12px] text-cream-faint">
                {t('composer.noFiles')}
              </div>
            ) : (
              fileItems.map((f, i) => {
                const slash = f.lastIndexOf('/')
                const dir = slash === -1 ? '' : f.slice(0, slash)
                const name = slash === -1 ? f : f.slice(slash + 1)
                return (
                  <button
                    key={f}
                    onMouseEnter={() => setAtMenuIndex(i)}
                    onClick={() => pickFile(f)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                      i === atMenuIndex ? 'bg-overlay-strong' : ''
                    }`}
                  >
                    <File size={12} className="shrink-0 text-cream-faint" />
                    <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-cream">
                      {name}
                    </span>
                    {dir && (
                      <span className="min-w-0 truncate text-[11px] text-cream-faint">{dir}</span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        )}
        <div
          className={`rounded-[16px] border border-line bg-ink-850 p-2 shadow-composer transition-all duration-200 ease-standard ${
            disabled
              ? ''
              : 'focus-within:border-accent/40 focus-within:shadow-[var(--shadow-composer),0_0_0_2px_var(--accent-soft)]'
          }`}
        >
          {queue.length > 0 && (
            <div className="flex flex-col gap-1.5 px-1.5 pb-2 pt-0.5">
              <div className="px-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-faint">
                {t('composer.queued')} · {queue.length}
              </div>
              {queue.map((m, i) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 rounded-full border border-line bg-overlay px-3 py-1"
                >
                  <span className="shrink-0 font-mono text-[10px] text-cream-faint">{i + 1}</span>
                  <span
                    className="min-w-0 flex-1 truncate text-[12px] text-cream-dim"
                    title={m.text}
                  >
                    {m.text.length > 40 ? `${m.text.slice(0, 40)}…` : m.text}
                  </span>
                  {m.images?.length ? (
                    <ImageIcon size={11} className="shrink-0 text-cream-faint" />
                  ) : null}
                  <button
                    onClick={() => handleSteerNow(m)}
                    disabled={steeringQueuedId === m.id}
                    title={steeringQueuedId === m.id ? t('composer.steering') : t('composer.steerNow')}
                    aria-label={steeringQueuedId === m.id ? t('composer.steering') : t('composer.steerNow')}
                    className="focus-ring shrink-0 rounded-full p-1 text-accent transition-colors hover:bg-overlay-strong disabled:cursor-wait disabled:opacity-60"
                  >
                    {steeringQueuedId === m.id ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Zap size={11} />
                    )}
                  </button>
                  <button
                    onClick={() => currentSessionId && removeQueuedMessage(currentSessionId, m.id)}
                    disabled={steeringQueuedId === m.id}
                    title={t('composer.remove')}
                    className="focus-ring shrink-0 rounded-full p-1 text-cream-faint transition-colors hover:bg-overlay-strong hover:text-cream disabled:cursor-wait disabled:opacity-60"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1.5 pb-2 pt-0.5">
              {images.map((img) => (
                <div
                  key={img.id}
                  className="relative h-14 w-14 overflow-hidden rounded-[10px] border border-line bg-ink-900"
                >
                  <img src={img.previewUrl} alt="" className="h-full w-full object-cover" />
                  <button
                    onClick={() =>
                      setImages((prev) => {
                        const next = prev.filter((p) => p.id !== img.id)
                        writeDraft(currentSessionId, text, next)
                        return next
                      })
                    }
                    title={t('composer.removeImage')}
                    className="absolute right-0.5 top-0.5 rounded-full bg-ink-950/85 p-0.5 text-cream-faint transition-colors hover:text-cream"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {imageError && (
            <div className="px-2.5 pb-1 text-[11px] text-red-500">
              {t(IMAGE_ERROR_KEYS[imageError])}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={loadedSessionId === currentSessionId ? text : ''}
            onChange={(e) => {
              const nextText = e.target.value
              setText(nextText)
              writeDraft(currentSessionId, nextText, images)
              setCaret(e.target.selectionStart)
              setMenuDismissed(false)
              setAtDismissed(false)
              setMenuIndex(0)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onPaste={handlePaste}
            disabled={disabled}
            placeholder={
              disabled
                ? t('composer.placeholderDisabled')
                : busy
                  ? t('composer.placeholderBusy')
                  : t('composer.placeholder')
            }
            rows={1}
            className="max-h-40 w-full resize-none bg-transparent px-2.5 py-1.5 text-[15px] leading-6 text-cream placeholder-cream-faint outline-none"
          />
          <div className="flex items-center justify-between px-1 pb-0.5 pt-0.5">
            <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <button
                onClick={handleAttachFile}
                title={t('composer.attach')}
                className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line text-cream-dim transition-all hover:border-ink-600 hover:text-cream"
              >
                <Paperclip size={12} />
              </button>
              <button
                onClick={handlePickImage}
                title={t('composer.attachImage')}
                className="focus-ring flex h-7 w-7 items-center justify-center rounded-full border border-line text-cream-dim transition-all hover:border-ink-600 hover:text-cream"
              >
                <ImageIcon size={12} />
              </button>
              <ModelPicker sessionId={currentSessionId} />
              <ThinkingPicker sessionId={currentSessionId} />
              <PermissionPicker />
            </div>
            {busy ? (
              <div className="flex items-center gap-1.5">
                {canSend && (
                  <>
                    <button
                      onClick={handleSend}
                      title={t('composer.queue')}
                      aria-label={t('composer.queue')}
                      className="flex h-8 items-center gap-1.5 rounded-full bg-overlay-strong px-2.5 text-[11px] font-medium text-cream-dim shadow-card transition-all duration-150 hover:bg-overlay hover:text-cream active:scale-95"
                    >
                      <ListPlus size={13} strokeWidth={2.5} />
                      <span>{t('composer.queue')}</span>
                    </button>
                    <button
                      onClick={handleSteerCurrent}
                      title={t('composer.steerNow')}
                      aria-label={t('composer.steerNow')}
                      className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-2.5 text-[11px] font-medium text-white shadow-card transition-all duration-150 hover:bg-accent-bright active:scale-95"
                    >
                      <Zap size={13} strokeWidth={2.5} />
                      <span>{t('composer.steerNow')}</span>
                    </button>
                  </>
                )}
                <button
                  onClick={onStop}
                  disabled={stopping}
                  title={stopping ? t('chat.stopping') : t('composer.stop')}
                  aria-label={stopping ? t('chat.stopping') : t('composer.stop')}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-cream text-ink-950 shadow-card transition-all duration-150 hover:opacity-85 active:scale-95 disabled:cursor-wait disabled:opacity-70"
                >
                  {stopping ? <Loader2 size={13} className="animate-spin" /> : <Square size={11} fill="currentColor" />}
                </button>
              </div>
            ) : (
              <button
                onClick={handleSend}
                disabled={!canSend}
                title={t('composer.send')}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-all duration-150 active:scale-95 ${
                  canSend
                    ? 'bg-accent text-white shadow-card hover:bg-accent-bright'
                    : 'cursor-not-allowed bg-overlay-strong text-cream-faint'
                }`}
              >
                <ArrowUp size={15} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-cream-faint">
          <div className="min-w-0 truncate">
            {currentSessionId && <UsageMonitor sessionId={currentSessionId} />}
          </div>
          <span className="hidden shrink-0 whitespace-nowrap min-[1100px]:inline">
            {t('composer.shortcuts')}
          </span>
        </div>
        <div className="mt-1 truncate whitespace-nowrap text-center text-[10.5px] text-cream-faint">
          {t('composer.disclaimer')}
        </div>
      </div>
    </div>
  )
}
