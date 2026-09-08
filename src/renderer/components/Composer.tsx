import { useState, useRef, useMemo, useEffect, ClipboardEvent, DragEvent, KeyboardEvent, memo } from 'react'
import {
  ArrowUp,
  Square,
  Paperclip,
  Image as ImageIcon,
  Zap,
  X,
  File,
  Folder,
  GitBranch,
  FileArchive,
  ListPlus,
  Loader2,
  MessageCircle,
  Plus
} from 'lucide-react'
import { PromptImage, SlashCommand } from '@shared/types'
import { QueuedMessage, useAppStore } from '../store'
import {
  ComposerDraftFile,
  ComposerFileKind,
  DroppedAttachment,
  SessionComposerDraft
} from '../lib/composerDraft'
import { dispatchSteer, steerFailureKey } from '../lib/steerDispatch'
import { useT } from '../i18n'
import { filterSlashItems, groupSlashItems, SlashMenuItem } from '../lib/slashCommands'
import { useGitInfo } from '../lib/useGitInfo'
import { basename } from '../lib/path'
import ModelPicker from './ModelPicker'
import ThinkingPicker from './ThinkingPicker'
import PermissionPicker from './PermissionPicker'
import UsageMonitor from './UsageMonitor'
import MenuPortal from './MenuPortal'

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
  /** Built-in app commands — always in the slash menu, even without a session. */
  appCommands?: AppCommandSpec[]
  /**
   * The chat column is narrower than 760px (browser panel open, small
   * window): pickers and status chips collapse to icon-only so the toolbar
   * never wraps. Primitive on purpose — Composer is memoized.
   */
  compact?: boolean
}



/** Built-in command surfaced in the slash menu regardless of session state. */
export interface AppCommandSpec {
  name: string
  description: string
  icon?: unknown
  run: () => void
}

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

/**
 * Image staging accepts these even when the drop carries no mime type — real
 * world macOS Finder drags often present `file.type` as empty.
 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'heic', 'svg'])
/** Non-image drops with these extensions render as archive chips. */
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'rar', '7z'])

/** Lowercased last path segment, or '' when the name has no extension. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSIONS.has(extensionOf(file.name))
}

function attachmentKind(isDirectory: boolean, name: string): ComposerFileKind {
  if (isDirectory) return 'folder'
  if (ARCHIVE_EXTENSIONS.has(extensionOf(name))) return 'archive'
  return 'file'
}

/** The outgoing `@path` reference block: one token per line under the text. */
function appendAttachmentRefs(text: string, files: DroppedAttachment[]): string {
  if (files.length === 0) return text
  return `${text}\n${files.map((f) => `@${f.path}`).join('\n')}`
}

function toDraftFile(file: DroppedAttachment): ComposerDraftFile {
  const { path, name, isDirectory, kind } = file
  return { path, name, isDirectory, kind }
}

function toDraftFiles(files: DroppedAttachment[]): ComposerDraftFile[] | undefined {
  return files.length ? files.map(toDraftFile) : undefined
}

function fromDraftFile(file: ComposerDraftFile): DroppedAttachment {
  return { ...file, id: crypto.randomUUID() }
}

const EMPTY_QUEUE: QueuedMessage[] = []

const IMAGE_ERROR_KEYS = {
  tooLarge: 'composer.imageTooLarge',
  max: 'composer.maxImages',
  notImage: 'composer.imageNotImage',
  readFailed: 'composer.imageReadFailed'
} as const

/**
 * One item captured synchronously from a drop. `File` objects and entries go
 * stale once the drop handler yields, so everything we need is copied out up
 * front and path resolution happens afterwards.
 */
interface DroppedEntry {
  file: File | null
  /** Entry-API directory flag: Finder folders arrive with no mime type. */
  isDirectory: boolean
  /** Display name, the fallback when no filesystem path can be resolved. */
  name: string
}

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

/**
 * Fit the single-line textarea to its content. The cap follows the viewport
 * (40vh, floored at 160px) so the card can never push its action row — or
 * itself — out of the window; the CSS max-h-[40vh] mirrors this as a safety
 * net when JS hasn't run yet.
 */
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  const cap = Math.max(160, Math.round(window.innerHeight * 0.4))
  el.style.height = `${Math.min(el.scrollHeight, cap)}px`
}

export default memo(function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  focusKey,
  stopping = false,
  commands = [],
  onCompact,
  appCommands,
  compact = false
}: ComposerProps) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const [atMenuIndex, setAtMenuIndex] = useState(0)
  const [atDismissed, setAtDismissed] = useState(false)
  const [images, setImages] = useState<PendingImage[]>([])
  /** Non-image drops staged as attachment chips; sent as @path lines. */
  const [pendingFiles, setPendingFiles] = useState<DroppedAttachment[]>([])
  const [steeringQueuedId, setSteeringQueuedId] = useState<string | null>(null)
  const steeringQueuedIdRef = useRef<string | null>(null)
  const [loadedSessionId, setLoadedSessionId] = useState<string | null | undefined>(undefined)
  const [imageError, setImageError] = useState<keyof typeof IMAGE_ERROR_KEYS | null>(null)
  /** A file drag hovers over the composer; drives the drop-zone highlight. */
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)
  const [projectFiles, setProjectFiles] = useState<string[]>([])
  const filesLoadedAt = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { info: gitInfo } = useGitInfo()
  const t = useT()
  const composerPrefill = useAppStore((s) => s.composerPrefill)
  const composerAutosend = useAppStore((s) => s.composerAutosend)
  const setComposerPrefill = useAppStore((s) => s.setComposerPrefill)
  const setComposerAutosend = useAppStore((s) => s.setComposerAutosend)
  /** Text armed by a one-click tool launch, sent once committed (see below). */
  const autosendRef = useRef<string | null>(null)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  // Primitive selector: re-renders only when the Feishu-origin flag flips.
  const feishuSync = useAppStore(
    (s) => s.sessions.find((session) => session.id === s.currentSessionId)?.origin === 'feishu'
  )
  /** Workspace-level branch for the header chip; null = not a git repo. */
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const setComposerDraft = useAppStore((s) => s.setComposerDraft)
  const clearComposerDraft = useAppStore((s) => s.clearComposerDraft)
  const queue = useAppStore((s) =>
    currentSessionId ? (s.queuedMessages[currentSessionId] ?? EMPTY_QUEUE) : EMPTY_QUEUE
  )
  const enqueueQueuedMessage = useAppStore((s) => s.enqueueQueuedMessage)
  const removeQueuedMessage = useAppStore((s) => s.removeQueuedMessage)
  const reserveQueuedMessage = useAppStore((s) => s.reserveQueuedMessage)

  const writeDraft = (
    sessionId: string | null,
    nextText: string,
    nextImages: PendingImage[],
    nextFiles: DroppedAttachment[] = pendingFiles
  ) => {
    if (!sessionId) return
    const draft: SessionComposerDraft = {
      text: nextText,
      images: toPromptImages(nextImages),
      files: toDraftFiles(nextFiles)
    }
    setComposerDraft(sessionId, draft)
  }

  const commitDraft = (nextText: string, nextImages = images, nextFiles = pendingFiles) => {
    setText(nextText)
    setImages(nextImages)
    setPendingFiles(nextFiles)
    writeDraft(currentSessionId, nextText, nextImages, nextFiles)
  }

  const clearLocalDraft = () => {
    setText('')
    setCaret(0)
    setImages([])
    setPendingFiles([])
    setImageError(null)
    setMenuDismissed(false)
    setAtDismissed(false)
    autosize(textareaRef.current)
  }

  // The Composer stays mounted while the selected transcript changes. Hydrate
  // the editing surface from the newly selected session and reset transient UI.
  useEffect(() => {
    textareaRef.current?.blur()
    const draft = currentSessionId ? useAppStore.getState().composerDrafts[currentSessionId] : undefined
    setText(draft?.text ?? '')
    setImages(draft ? fromPromptImages(draft.images) : [])
    setPendingFiles(draft?.files ? draft.files.map(fromDraftFile) : [])
    setCaret(draft?.text.length ?? 0)
    setMenuIndex(0)
    setMenuDismissed(false)
    setAtMenuIndex(0)
    setAtDismissed(false)
    setImageError(null)
    setLoadedSessionId(currentSessionId)
    requestAnimationFrame(() => {
      autosize(textareaRef.current)
    })
  }, [currentSessionId])

  // One-shot prefill requested by another page (e.g. "build your own plugin")
  useEffect(() => {
    if (composerPrefill == null) return
    commitDraft(composerPrefill)
    setCaret(composerPrefill.length)
    if (composerAutosend) autosendRef.current = composerPrefill
    setComposerPrefill(null)
    setComposerAutosend(false)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
      autosize(el)
    })
  }, [composerPrefill, composerAutosend, setComposerPrefill, setComposerAutosend])

  // One-click tool launch: fire the send as soon as the prefilled text is
  // committed to the textarea state of this render. A mid-turn session is
  // fine — handleSend parks the message in the drain-on-idle queue, and a
  // freshly spawned session buffers the prompt on its stdin until the RPC
  // handshake completes.
  useEffect(() => {
    const pending = autosendRef.current
    if (pending == null || disabled) return
    if (text !== pending) return
    autosendRef.current = null
    handleSend()
  }, [text, disabled])

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

  // Slash menu is active while the whole input is a single "/partial" token.
  // Built-in app commands (navigate/act) always participate; runtime prompts
  // and skills join when a session provides them.
  const slashQuery = /^\/(\S*)$/.test(text) && !menuDismissed ? text.slice(1).toLowerCase() : null
  const menuItems = useMemo<SlashMenuItem[]>(() => {
    const appItems: SlashMenuItem[] = (appCommands ?? []).map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      source: 'app' as const,
      icon: cmd.icon,
      run: cmd.run
    }))
    const all: SlashMenuItem[] = [
      ...appItems,
      ...(onCompact
        ? [{ name: 'compact', description: t('composer.slashCompact'), source: 'prompt' as const, builtin: true }]
        : []),
      ...commands.map((c) => ({ name: c.name, description: c.description ?? '', source: c.source }))
    ]
    return filterSlashItems(all, slashQuery)
  }, [slashQuery, commands, onCompact, t, appCommands])
  const menuOpen = menuItems.length > 0
  const menuGroups = useMemo(
    () =>
      groupSlashItems(menuItems, {
        app: t('slash.groupApp'),
        command: t('slash.groupCommand'),
        skill: t('slash.groupSkill')
      }),
    [menuItems, t]
  )

  // @ file menu: active on a trailing "@token". Without a workspace there is
  // no file list to show — surface the reason instead of swallowing the "@".
  const atTokenMatch = useMemo(() => {
    if (atDismissed || slashQuery !== null) return null
    return atToken(text, caret)
  }, [text, caret, atDismissed, slashQuery])
  const at = currentWorkspace ? atTokenMatch : null
  const atOpen = at !== null
  const atNeedProject = !currentWorkspace && atTokenMatch !== null

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
      autosize(el)
    })
  }

  const pickCommand = (item: SlashMenuItem) => {
    if (item.run) {
      // App command: clear the "/partial" and execute — navigation and other
      // side effects live in the callback provided by ChatPanel.
      commitDraft('')
      setCaret(0)
      item.run()
      return
    }
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

  /** Shared image staging pipeline for pasted and dropped files. */
  const stageImageFiles = (files: File[]) => {
    const remaining = Math.max(0, MAX_IMAGES - images.length)
    let claimed = 0
    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) {
        setImageError('tooLarge')
        continue
      }
      if (claimed >= remaining) {
        setImageError('max')
        continue
      }
      claimed += 1
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

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length === 0) return
    e.preventDefault()
    stageImageFiles(files)
  }

  /**
   * Stage non-image drops (files, folders, archives) as attachment chips.
   * Paths resolve through the main process; virtual files that carry no
   * filesystem path keep their display name. Dedupe is by resolved path.
   */
  const stageDroppedFiles = (dropped: DroppedEntry[]) => {
    const sessionIdAtAction = currentSessionId
    const textAtAction = text
    const imagesAtAction = images
    const resolved: DroppedAttachment[] = []
    for (const entry of dropped) {
      let path = entry.name
      if (entry.file) {
        try {
          const resolvedPath = window.electronAPI.getPathForFile(entry.file)
          if (resolvedPath) path = resolvedPath
        } catch {
          // Virtual files (dragged out of another app) carry no filesystem path.
        }
      }
      if (!path) continue
      const name = entry.name || path.split('/').pop() || path
      resolved.push({
        id: crypto.randomUUID(),
        path,
        name,
        isDirectory: entry.isDirectory,
        kind: attachmentKind(entry.isDirectory, name)
      })
    }
    if (resolved.length === 0) return
    setPendingFiles((prev) => {
      const next = [...prev]
      let added = false
      for (const att of resolved) {
        if (next.some((p) => p.path === att.path)) continue
        next.push(att)
        added = true
      }
      if (added) writeDraft(sessionIdAtAction, textAtAction, imagesAtAction, next)
      return next
    })
  }

  /**
   * Route a drop: images join the staging pipeline, everything else (files,
   * folders, archives) becomes an attachment chip sent as an @path reference.
   * Items are snapshotted synchronously — File objects go stale once this
   * handler yields.
   */
  const routeDroppedItems = (dt: DataTransfer) => {
    const entries: DroppedEntry[] = []
    for (const item of Array.from(dt.items ?? [])) {
      let isDirectory = false
      let entryName = ''
      try {
        const entry = item.webkitGetAsEntry()
        isDirectory = entry?.isDirectory ?? false
        entryName = entry?.name ?? ''
      } catch {
        // Synthetic/internal drags can carry stale entries; files still work.
      }
      const file = item.getAsFile()
      if (file || entryName) entries.push({ file, isDirectory, name: file?.name || entryName })
    }
    if (entries.length === 0) {
      for (const file of Array.from(dt.files)) {
        entries.push({ file, isDirectory: false, name: file.name })
      }
    }
    const imageFiles: File[] = []
    const fileEntries: DroppedEntry[] = []
    for (const entry of entries) {
      // Folders never stage as images even when named like one (shot.png/).
      if (!entry.isDirectory && entry.file && isImageFile(entry.file)) {
        imageFiles.push(entry.file)
      } else {
        fileEntries.push(entry)
      }
    }
    if (imageFiles.length > 0) stageImageFiles(imageFiles)
    if (fileEntries.length > 0) stageDroppedFiles(fileEntries)
  }

  const hasFileDrag = (e: DragEvent<HTMLDivElement>) => e.dataTransfer.types.includes('Files')

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFileDrag(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDropping(true)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFileDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(e)) return
    // enter/leave fire for every child crossed; the depth counter only
    // reaches zero when the drag truly exits the composer, so the
    // highlight never flickers while moving over children.
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropping(false)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFileDrag(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDropping(false)
    routeDroppedItems(e.dataTransfer)
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

  /** Steer accepted: append the steer bubble + trajectory fact, clear stale errors. */
  const commitAcceptedSteer = (sessionId: string, text: string, imgs?: PromptImage[]) => {
    const latest = useAppStore.getState()
    if (!latest.sessions.some((session) => session.id === sessionId)) return false
    latest.addMessage(sessionId, {
      id: crypto.randomUUID(),
      role: 'user',
      kind: 'steer',
      content: text,
      images: imgs?.map(({ data, mimeType }) => ({ data, mimeType }))
    })
    latest.recordSteer(sessionId, text)
    latest.setSessionError(sessionId, null)
    return true
  }

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    const sessionIdAtSend = currentSessionId
    const imgs = stagedImages()
    // Attachment chips ride along as one @path token per line; they are
    // cleared on send and restored only if delivery fails (see below).
    const staged = pendingFiles
    const outgoing = appendAttachmentRefs(trimmed, staged)
    if (busy) {
      // Mid-turn: park the message; the store drains the queue on idle.
      if (!currentSessionId) return
      enqueueQueuedMessage(currentSessionId, {
        id: crypto.randomUUID(),
        text: outgoing,
        images: imgs
      })
    } else {
      // The send is async: clear optimistically, but roll the draft back when
      // delivery failed (dead session, invalid grant) so it is never lost.
      const stagedImagesSnapshot = images
      const restore = (ok: void | boolean) => {
        if (ok !== false) return
        const restoreSessionId = sessionIdAtSend ?? useAppStore.getState().currentSessionId
        if (restoreSessionId) {
          setComposerDraft(restoreSessionId, {
            text: trimmed,
            images: toPromptImages(stagedImagesSnapshot),
            files: toDraftFiles(staged)
          })
        }
        if (
          (sessionIdAtSend && useAppStore.getState().currentSessionId !== sessionIdAtSend) ||
          (!sessionIdAtSend && restoreSessionId !== useAppStore.getState().currentSessionId)
        ) {
          return
        }
        setText((cur) => (cur.trim() ? cur : trimmed))
        setImages((cur) => (cur.length ? cur : stagedImagesSnapshot))
        setPendingFiles((cur) => (cur.length ? cur : staged))
        setCaret(trimmed.length)
      }
      if (sessionIdAtSend) clearComposerDraft(sessionIdAtSend)
      if (!sessionIdAtSend || useAppStore.getState().currentSessionId === sessionIdAtSend) {
        clearLocalDraft()
      }
      const result = onSend(outgoing, imgs)
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
          if (commitAcceptedSteer(sessionId, m.text, m.images)) {
            latest.removeQueuedMessage(sessionId, m.id)
          } else {
            latest.releaseQueuedMessage(sessionId, m.id)
          }
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
    const stagedFiles = pendingFiles
    const imgs = stagedImages()
    const outgoing = appendAttachmentRefs(trimmed, stagedFiles)
    const store = useAppStore.getState()
    store.clearComposerDraft(sessionId)
    clearLocalDraft()

    void dispatchSteer({
      sessionId,
      text: outgoing,
      images: imgs,
      source: 'composer',
      steer: (sid, text, images) => window.electronAPI.steer(sid, text, images)
    }).then((result) => {
      const latest = useAppStore.getState()
      if (result.ok) {
        commitAcceptedSteer(sessionId, outgoing, imgs)
        return
      }

      if (!latest.sessions.some((session) => session.id === sessionId)) return
      latest.setComposerDraft(sessionId, {
        text: trimmed,
        images: toPromptImages(staged),
        files: toDraftFiles(stagedFiles)
      })
      latest.setSessionError(sessionId, steerFailureKey(result.source))
      if (latest.currentSessionId !== sessionId) return
      setText(trimmed)
      setImages(staged)
      setPendingFiles(stagedFiles)
      setCaret(trimmed.length)
    })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (atNeedProject && e.key === 'Escape') {
      e.preventDefault()
      setAtDismissed(true)
      return
    }
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
    autosize(textareaRef.current)
  }

  const canSend = !disabled && Boolean(text.trim())

  return (
    // Home (no active session) trims the outer bottom padding: the hint line
    // below the card takes over the rhythm.
    <div className={`px-4 pt-2 ${currentSessionId ? 'pb-4' : 'pb-1'}`}>
      <div className="relative mx-auto w-full max-w-3xl">
        {slashQuery !== null && (
          <div className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-line bg-ink-850 p-1 shadow-pop">
            <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-faint">
              {t('composer.slashTitle')}
            </div>
            {menuItems.length === 0 ? (
              <div className="px-2.5 py-2 text-[12px] text-cream-faint">
                {t('composer.slashEmpty')}
              </div>
            ) : (
              menuGroups.map((group) => (
                <div key={group.label}>
                  <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-faint">
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    const i = menuItems.indexOf(item)
                    const Icon = (item.icon as typeof Zap) ?? Zap
                    return (
                      <button
                        key={`${item.source}-${item.name}`}
                        onMouseEnter={() => setMenuIndex(i)}
                        onClick={() => pickCommand(item)}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                          i === menuIndex ? 'bg-overlay-strong' : ''
                        }`}
                      >
                        <Icon
                          size={12}
                          className={
                            item.source === 'app' || item.builtin
                              ? 'shrink-0 text-accent'
                              : 'shrink-0 text-cream-faint'
                          }
                        />
                        <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-cream">
                          /{item.name}
                        </span>
                        {item.description && (
                          <span className="min-w-0 truncate text-[11px] text-cream-faint">
                            {item.description}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 font-mono text-[9.5px] uppercase tracking-wider text-cream-faint">
                          {item.builtin ? t('composer.slashBuiltin') : item.source === 'app' ? '应用' : item.source}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        )}
        {atNeedProject && (
          <div className="absolute bottom-full left-0 right-0 z-20 mb-2 rounded-xl border border-line bg-ink-850 p-1 shadow-pop">
            <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-faint">
              {t('composer.atTitle')}
            </div>
            <div className="px-2.5 py-2 text-[12px] text-cream-faint">
              {t('composer.atNeedProject')}
            </div>
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
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative rounded-[16px] border bg-ink-850 p-2 shadow-composer transition-all duration-200 ease-standard ${
            dropping
              ? 'border-dashed border-accent/70 shadow-[var(--shadow-composer),0_0_0_2px_var(--accent-soft)]'
              : disabled
                ? 'border-line'
                : 'border-line focus-within:border-accent/40 focus-within:shadow-[var(--shadow-composer),0_0_0_2px_var(--accent-soft)]'
          }`}
        >
          {dropping && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[16px] bg-ink-950/45">
              <div className="flex items-center gap-1.5 rounded-full border border-accent/50 bg-ink-900 px-3 py-1 text-[11px] font-medium text-cream-dim shadow-pop">
                <ImageIcon size={12} className="text-accent" />
                <span>{t('composer.dropHint')}</span>
              </div>
            </div>
          )}
          {/* Attached workspace header (home only): the project/branch row is
              the card's own top section — a slightly different shade, no gap,
              so it grows with the textarea like one continuous surface. */}
          {currentWorkspace && !currentSessionId && (
            <div className="flex items-center gap-1 rounded-t-[15px] bg-overlay/60 px-3 py-2.5">
              <div
                title={currentWorkspace.displayPath}
                aria-label={t('composer.currentProject')}
                className="flex shrink-0 items-center gap-1.5 text-[12px] font-medium whitespace-nowrap text-cream-dim"
              >
                <Folder size={12} className="shrink-0 text-accent" />
                <span className="max-w-[180px] truncate">
                  {currentWorkspace.source === 'default'
                    ? t('sidebar.defaultWorkspace')
                    : basename(currentWorkspace.displayPath) || currentWorkspace.displayPath}
                </span>
              </div>
              {currentWorkspace.source !== 'default' && gitInfo && (
                <div
                  title={gitInfo.branch}
                  className="flex shrink-0 items-center gap-1.5 pl-2 text-[12px] font-medium whitespace-nowrap text-cream-dim"
                >
                  <GitBranch size={12} className="shrink-0 text-accent" />
                  <span className="max-w-[160px] truncate font-mono">{gitInfo.branch}</span>
                </div>
              )}
            </div>
          )}
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
          {(images.length > 0 || pendingFiles.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 px-1.5 pb-2 pt-0.5">
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
              {pendingFiles.map((file) => (
                <div
                  key={file.id}
                  title={file.path}
                  className="flex h-14 min-w-0 items-center gap-2 rounded-[10px] border border-line bg-ink-900 py-1 pl-2.5 pr-1"
                >
                  {file.kind === 'folder' ? (
                    <Folder size={16} className="shrink-0 text-accent" />
                  ) : file.kind === 'archive' ? (
                    <FileArchive size={16} className="shrink-0 text-cream-faint" />
                  ) : (
                    <File size={16} className="shrink-0 text-cream-faint" />
                  )}
                  <span className="min-w-0 max-w-[150px] truncate text-[12px] text-cream-dim">
                    {file.name}
                  </span>
                  <button
                    onClick={() =>
                      setPendingFiles((prev) => {
                        const next = prev.filter((p) => p.id !== file.id)
                        writeDraft(currentSessionId, text, images, next)
                        return next
                      })
                    }
                    title={t('composer.removeAttachment')}
                    aria-label={t('composer.removeAttachment')}
                    className="focus-ring shrink-0 rounded-full p-1 text-cream-faint transition-colors hover:bg-overlay-strong hover:text-cream"
                  >
                    <X size={12} />
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
            className="max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent px-2.5 py-1.5 text-[15px] leading-6 text-cream placeholder-cream-faint outline-none"
          />
          <div className="flex items-center justify-between gap-2 px-1 pb-0.5 pt-0.5">
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <button
                  ref={addButtonRef}
                  onClick={() => setAddMenuOpen((v) => !v)}
                  title={t('composer.addContent')}
                  aria-label={t('composer.addContent')}
                  aria-haspopup="menu"
                  aria-expanded={addMenuOpen}
                  className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-cream-dim transition-colors hover:bg-overlay hover:text-cream"
                >
                  <Plus size={14} />
                </button>
                <MenuPortal
                  open={addMenuOpen}
                  triggerRef={addButtonRef}
                  onClose={() => setAddMenuOpen(false)}
                  width={176}
                >
                  <button
                    onClick={() => {
                      setAddMenuOpen(false)
                      void handlePickImage()
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay"
                  >
                    <ImageIcon size={13} className="shrink-0 text-cream-faint" />
                    {t('composer.attachImage')}
                  </button>
                  <button
                    onClick={() => {
                      setAddMenuOpen(false)
                      void handleAttachFile()
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay"
                  >
                    <Paperclip size={13} className="shrink-0 text-cream-faint" />
                    {t('composer.attach')}
                  </button>
                </MenuPortal>
              </div>
              <PermissionPicker compact={compact} />
              {feishuSync && (
                <div
                  title={t('composer.feishuSync')}
                  className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] font-medium whitespace-nowrap text-cream-dim transition-colors hover:bg-overlay"
                >
                  <MessageCircle size={11} className="shrink-0 text-accent" />
                  {!compact && <span>{t('composer.feishuSync')}</span>}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <ModelPicker sessionId={currentSessionId} compact={compact} />
              <ThinkingPicker sessionId={currentSessionId} compact={compact} />
              {busy ? (
                <div className="flex items-center gap-1.5">
                  {canSend && (
                    <>
                      <button
                        onClick={handleSend}
                        title={t('composer.queue')}
                        aria-label={t('composer.queue')}
                        className={`flex h-8 items-center gap-1.5 rounded-full bg-overlay-strong text-[11px] font-medium text-cream-dim shadow-card transition-all duration-150 hover:bg-overlay hover:text-cream active:scale-95 ${
                          compact ? 'w-8 justify-center' : 'px-2.5'
                        }`}
                      >
                        <ListPlus size={13} strokeWidth={2.5} />
                        {!compact && <span>{t('composer.queue')}</span>}
                      </button>
                      <button
                        onClick={handleSteerCurrent}
                        title={t('composer.steerNow')}
                        aria-label={t('composer.steerNow')}
                        className={`flex h-8 items-center gap-1.5 rounded-full bg-accent text-[11px] font-medium text-white shadow-card transition-all duration-150 hover:bg-accent-bright active:scale-95 ${
                          compact ? 'w-8 justify-center' : 'px-2.5'
                        }`}
                      >
                        <Zap size={13} strokeWidth={2.5} />
                        {!compact && <span>{t('composer.steerNow')}</span>}
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
                  className={`flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-150 active:scale-95 ${
                    canSend
                      ? 'bg-accent text-white shadow-card hover:bg-accent-bright'
                      : 'cursor-not-allowed bg-overlay-strong text-cream-faint'
                  }`}
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
        {currentSessionId ? (
          <>
            <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-cream-faint">
              <div className="min-w-0 truncate">
                <UsageMonitor sessionId={currentSessionId} />
              </div>
              {/* Shortcuts hint needs ~1100px of window AND a non-squeezed chat
                  column (browser panel open): compact covers the panel case the
                  window media query cannot see. Home never sees this row — its
                  single hint line below the card replaces it. */}
              <span
                className={`hidden shrink-0 whitespace-nowrap min-[1100px]:inline ${
                  compact ? '!hidden' : ''
                }`}
              >
                {t('composer.shortcuts')}
              </span>
            </div>
            <div className="mt-1 truncate whitespace-nowrap text-center text-[10.5px] text-cream-faint">
              {t('composer.disclaimer')}
            </div>
          </>
        ) : (
          // Home: the hint line and workspace strip render in ChatPanel below
          // and above the card — the composer itself adds nothing here.
          null
        )}
      </div>
    </div>
  )
})

/**
 * Memoized: ChatPanel re-renders on every streaming delta; the composer's
 * props (primitives + ChatPanel-stabilized callbacks) do not change then, so
 * the whole input surface — pickers included — skips those renders. Typing
 * latency depends on this: the textarea must not re-render on unrelated
 * store churn.
 */
