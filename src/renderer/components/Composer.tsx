import { autosendForPrefill } from '../lib/composerAutosend'
import { ComposerInvocation, planInvocation } from '../lib/composerInvocation'
import { useState, useRef, useMemo, useEffect, useId, ClipboardEvent, DragEvent, KeyboardEvent, memo } from 'react'
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
  Plus,
  Plug,
  Sparkles,
  ChevronDown,
  Layers
} from 'lucide-react'
import { AttachedImage } from './ChatAttachment'
import { base64DecodedBytes, IMAGE_MIME_BY_EXT, isPromptImageMime, MAX_IMAGE_BYTES, MAX_IMAGE_COUNT as MAX_IMAGES, MAX_TOTAL_IMAGE_BYTES } from '@shared/promptImages'
import { PromptImage, SlashCommand } from '@shared/types'
import { isMcpMentionName, MCP_MENTION_PREFIX } from '@shared/mcpMentions'
import { QueuedMessage, useAppStore } from '../store'
import {
  ComposerDraftFile,
  ComposerFileKind,
  DroppedAttachment,
  NEW_CHAT_DRAFT_KEY,
  sessionComposerDraftKey
} from '../lib/composerDraft'
import { dispatchSteer, steerFailureKey } from '../lib/steerDispatch'
import { useT } from '../i18n'
import { filterSlashItems, groupSlashItems, SlashMenuItem } from '../lib/slashCommands'
import { useGitInfo } from '../lib/useGitInfo'
import { basename } from '../lib/path'
import { showNotice } from '../lib/notice'
import ModelThinkingPicker from './ModelThinkingPicker'
import PermissionPicker from './PermissionPicker'
import UsageMonitor, { ContextReadout } from './UsageMonitor'
import MenuPortal, { ComposerMenuPlacement } from './MenuPortal'
import InvokePicker from './InvokePicker'
import ProjectPicker from './ProjectPicker'
import MagneticButton from './effects/MagneticButton'
import { useProjects } from '../store/projects'
import './AgentHome.css'

interface ComposerProps {
  /** Delivers the composed text; resolves false when delivery failed and the draft is restored. */
  onSend: (text: string, images?: PromptImage[], onTarget?: (sessionId: string) => void) => void | boolean | Promise<void | boolean>
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

const MAX_FILE_ITEMS = 20
const MAX_MCP_ITEMS = 20
/** Hard cap for one paste; anything larger freezes the composer pipeline. */
const MAX_PASTE_CHARS = 100_000
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
  total: 'composer.imagesTotalTooLarge',
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
  const [readingImages, setReadingImages] = useState(false)
  const activeReaders = useRef(new Set<FileReader>())
  /** Non-image drops staged as attachment chips; sent as @path lines. */
  const [pendingFiles, setPendingFiles] = useState<DroppedAttachment[]>([])
  const [steeringQueuedId, setSteeringQueuedId] = useState<string | null>(null)
  const steeringQueuedIdRef = useRef<string | null>(null)
  const [loadedSessionId, setLoadedSessionId] = useState<string | null | undefined>(undefined)
  const [imageError, setImageError] = useState<keyof typeof IMAGE_ERROR_KEYS | null>(null)
  /** A file drag hovers over the composer; drives the drop-zone highlight. */
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)
  const [workspaceFiles, setWorkspaceFiles] = useState<{ id: string; files: string[] } | null>(null)
  const filesLoadedAt = useRef<{ id: string; time: number } | null>(null)
  const [mcpNames, setMcpNames] = useState<string[]>([])
  const [mcpStatus, setMcpStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const mentionMenuId = useId()
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
  const compacting = useAppStore(s => Boolean(currentSessionId && s.compacting[currentSessionId]))
  const compactUnavailable = busy || disabled || stopping || compacting
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  // Primitive selector: re-renders only when the Feishu-origin flag flips.
  const feishuSync = useAppStore(
    (s) => s.sessions.find((session) => session.id === s.currentSessionId)?.origin === 'feishu'
  )
  /** Workspace-level branch for the header chip; null = not a git repo. */
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const firstAddActionRef = useRef<HTMLButtonElement>(null)
  const [invokeTarget, setInvokeTarget] = useState<{ sessionId: string | null; workspaceId: string | undefined; anchor: 'plus' | 'tray' } | null>(null)
  const invokeOpen = !disabled && invokeTarget?.sessionId === currentSessionId && invokeTarget.workspaceId === currentWorkspace?.id
  useEffect(() => {
    if (!invokeOpen) setInvokeTarget(null)
  }, [invokeOpen])
  // Home tray (选择项目 / 插件) — design.md 5.2: the soft-gray base connected
  // under the white input card carries project scope and plugin entry.
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const projects = useProjects(state => state.projects)
  const projectButtonRef = useRef<HTMLButtonElement>(null)
  const pluginButtonRef = useRef<HTMLButtonElement>(null)
  const setComposerDraft = useAppStore((s) => s.setComposerDraft)
  const clearComposerDraft = useAppStore((s) => s.clearComposerDraft)
  const queue = useAppStore((s) =>
    currentSessionId ? (s.queuedMessages[currentSessionId] ?? EMPTY_QUEUE) : EMPTY_QUEUE
  )
  const queuePaused = useAppStore((s) => Boolean(currentSessionId && s.queuePauseReasons[currentSessionId]))
  const dispatchingId = useAppStore((s) => currentSessionId ? s.queueDispatching[currentSessionId]?.id : undefined)
  const enqueueQueuedMessage = useAppStore((s) => s.enqueueQueuedMessage)
  const removeQueuedMessage = useAppStore((s) => s.removeQueuedMessage)
  const reserveQueuedMessage = useAppStore((s) => s.reserveQueuedMessage)

  const writeDraft = (
    sessionId: string | null,
    nextText: string,
    nextImages: PendingImage[],
    nextFiles: DroppedAttachment[] = pendingFiles
  ) => {
    setComposerDraft(sessionId ?? NEW_CHAT_DRAFT_KEY, {
      text: nextText,
      images: toPromptImages(nextImages),
      files: toDraftFiles(nextFiles)
    })
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
    // Pending reads belong to the old draft. Their callbacks must never attach to the new one.
    for (const reader of Array.from(activeReaders.current)) reader.abort()
    activeReaders.current.clear()
    setReadingImages(false)
    const sessionId = currentSessionId ?? NEW_CHAT_DRAFT_KEY
    const readDraft = (state: ReturnType<typeof useAppStore.getState>) => {
      const session = state.sessions.find((item) => item.id === currentSessionId)
      return state.composerDrafts[session ? sessionComposerDraftKey(session) : sessionId]
    }
    const store = useAppStore.getState()
    const draft = readDraft(store)
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
    // The startup disk hydration (hydrateComposerDrafts) can land AFTER this
    // mount read an empty store — currentSessionId never changed, so the
    // effect above will not re-run on its own. Adopt the late draft only
    // while the surface is still untouched; once the user types, the store
    // follows the composer, never the other way around.
    if (draft) return
    const initialVersion = store.getComposerDraftVersion(sessionId)
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.currentSessionId !== currentSessionId || state.getComposerDraftVersion(sessionId) !== initialVersion) {
        unsubscribe()
        return
      }
      const late = readDraft(state)
      if (!late) return
      unsubscribe()
      setText(late.text)
      setImages(fromPromptImages(late.images))
      setPendingFiles(late.files ? late.files.map(fromDraftFile) : [])
      setCaret(late.text.length)
      requestAnimationFrame(() => {
        autosize(textareaRef.current)
      })
    })
    return unsubscribe
  }, [currentSessionId])

  // One-shot prefill requested by another page (e.g. "build your own plugin")
  useEffect(() => {
    if (composerPrefill == null) return
    commitDraft(composerPrefill)
    setCaret(composerPrefill.length)
    autosendRef.current = autosendForPrefill(composerPrefill, composerAutosend)
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
      if (!el || addButtonRef.current?.getAttribute('aria-expanded') === 'true') return
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
    // The menu exists ONLY while the whole input is "/partial" — without this
    // gate the palette is always "open" and Enter would run a command instead
    // of sending the message (basic chat breakage).
    if (slashQuery === null) return []
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
      ...commands.filter(c => !onCompact || c.name !== 'compact').map((c) => ({ name: c.name, description: c.description ?? '', source: c.source }))
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

  const at = useMemo(() => {
    if (disabled || atDismissed || slashQuery !== null || loadedSessionId !== currentSessionId) return null
    return atToken(text, caret)
  }, [text, caret, disabled, atDismissed, slashQuery, loadedSessionId, currentSessionId])
  const atOpen = at !== null
  const atQuery = at?.query.toLowerCase() ?? ''
  const mcpOnly = atQuery.startsWith(MCP_MENTION_PREFIX)
  const workspaceId = currentWorkspace?.id
  const projectFiles = workspaceFiles?.id === workspaceId ? workspaceFiles?.files : undefined
  const wantFiles = atOpen && !mcpOnly && Boolean(workspaceId)

  // A closed menu or workspace change must not apply stale file results.
  useEffect(() => {
    if (!wantFiles || !workspaceId || !window.electronAPI.listProjectFiles) return
    const cached = filesLoadedAt.current
    if (cached?.id === workspaceId && Date.now() - cached.time < FILE_LIST_TTL_MS) return
    let cancelled = false
    window.electronAPI.listProjectFiles(workspaceId).then((files) => {
      if (!cancelled) {
        filesLoadedAt.current = { id: workspaceId, time: Date.now() }
        setWorkspaceFiles({ id: workspaceId, files })
      }
    }).catch(() => {
      if (!cancelled) setWorkspaceFiles({ id: workspaceId, files: [] })
    })
    return () => {
      cancelled = true
    }
  }, [wantFiles, workspaceId])

  useEffect(() => {
    if (!atOpen) return
    if (!window.electronAPI.mcpList) {
      setMcpNames([])
      setMcpStatus('ready')
      return
    }
    let cancelled = false
    setMcpNames([])
    setMcpStatus('loading')
    window.electronAPI.mcpList().then((connections) => {
      if (cancelled) return
      setMcpNames(connections.filter(({ enabled, name }) => enabled && isMcpMentionName(name)).map(({ name }) => name))
      setMcpStatus('ready')
    }).catch(() => {
      if (!cancelled) setMcpStatus('error')
    })
    return () => { cancelled = true }
  }, [atOpen])

  const mcpItems = useMemo(() => {
    if (!atOpen) return []
    const query = mcpOnly ? atQuery.slice(MCP_MENTION_PREFIX.length) : atQuery
    return mcpNames.filter(name => name.toLowerCase().includes(query)).slice(0, MAX_MCP_ITEMS)
  }, [atOpen, atQuery, mcpNames, mcpOnly])

  const fileItems = useMemo(() => {
    if (!wantFiles || !projectFiles) return []
    const hits = atQuery ? projectFiles.filter((f) => f.toLowerCase().includes(atQuery)) : projectFiles
    // Basename hits first, then shorter paths
    return [...hits]
      .sort((a, b) => {
        if (!atQuery) return 0
        const an = basename(a).toLowerCase().includes(atQuery) ? 0 : 1
        const bn = basename(b).toLowerCase().includes(atQuery) ? 0 : 1
        return an - bn || a.length - b.length
      })
      .slice(0, MAX_FILE_ITEMS)
  }, [wantFiles, atQuery, projectFiles])

  const mentionCount = mcpItems.length + fileItems.length
  const activeMentionIndex = Math.min(atMenuIndex, mentionCount - 1)
  // Reset the highlight only when the user's query (or a fresh menu open)
  // changes — the async MCP/file lists resolving 0 → N must not yank an
  // in-progress arrow-key selection back to the top.
  useEffect(() => { setAtMenuIndex(0) }, [atQuery, atOpen])

  /** Replace text[start:end] with insert and place the caret after it. */
  const replaceRange = (start: number, end: number, insert: string) => {
    const el = textareaRef.current
    if (!el || el.disabled) return
    const normalized = insert.replace(/\r\n?/g, '\n')
    const next = el.value.slice(0, start) + normalized + el.value.slice(end)
    const pos = start + normalized.length
    el.focus()
    el.setSelectionRange(start, end)
    // Chromium sends a native input event for insertText, so the controlled
    // textarea's onChange saves the edit and preserves the undo history.
    if (document.execCommand('insertText', false, normalized) && el.value === next) return
    commitDraft(next)
    setCaret(pos)
    requestAnimationFrame(() => {
      if (textareaRef.current !== el) return
      el.setSelectionRange(pos, pos)
      autosize(el)
    })
  }

  const pickInvocation = (invocation: ComposerInvocation) => {
    const state = useAppStore.getState()
    const el = textareaRef.current
    if (!invokeTarget || !el || disabled || state.currentSessionId !== invokeTarget.sessionId ||
        state.currentWorkspace?.id !== invokeTarget.workspaceId) return
    const edit = planInvocation(el.value, el.selectionStart, el.selectionEnd, invocation)
    if (!edit) {
      showNotice('composer.invoke.commandMcpConflict')
      el.focus()
      return
    }
    replaceRange(edit.start, edit.end, edit.insert)
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
      if (compactUnavailable) return
      commitDraft('')
      setCaret(0)
      onCompact?.()
      return
    }
    const next = `/${item.name} `
    replaceRange(0, text.length, next)
  }

  const pickMention = (index: number) => {
    if (!at) return
    if (index >= mcpItems.length) {
      replaceRange(at.start, caret, `@${fileItems[index - mcpItems.length]} `)
      return
    }
    const edit = planInvocation(text, at.start, caret, { kind: 'mcp', name: mcpItems[index] })
    if (!edit) {
      setAtDismissed(true)
      showNotice('composer.invoke.commandMcpConflict')
      return
    }
    replaceRange(edit.start, edit.end, edit.insert)
  }

  const addImage = (data: string, mimeType: string) => {
    const state = useAppStore.getState()
    if (state.currentSessionId !== currentSessionId) return
    const session = state.sessions.find(item => item.id === currentSessionId)
    const draft = state.composerDrafts[session ? sessionComposerDraftKey(session) : NEW_CHAT_DRAFT_KEY]
    const previous = draft?.images ?? []
    if (previous.length >= MAX_IMAGES) { setImageError('max'); return }
    const bytes = base64DecodedBytes(data)
    if (!bytes) { setImageError('readFailed'); return }
    if (previous.reduce((sum, image) => sum + base64DecodedBytes(image.data), bytes) > MAX_TOTAL_IMAGE_BYTES) {
      setImageError('total')
      return
    }
    const image = { id: crypto.randomUUID(), data, mimeType, previewUrl: 'data:' + mimeType + ';base64,' + data }
    state.setComposerDraft(currentSessionId ?? NEW_CHAT_DRAFT_KEY, {
      text: draft?.text ?? textareaRef.current?.value ?? '', files: draft?.files,
      images: [...previous, { type: 'image', data, mimeType }]
    })
    setImages(prev => [...prev, image])
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
      const mimeType = file.type || IMAGE_MIME_BY_EXT[extensionOf(file.name)]
      if (!mimeType || !isPromptImageMime(mimeType)) {
        setImageError('notImage')
        continue
      }
      claimed += 1
      const reader = new FileReader()
      activeReaders.current.add(reader)
      setReadingImages(true)
      reader.onloadend = () => {
        activeReaders.current.delete(reader)
        if (!activeReaders.current.size) setReadingImages(false)
      }
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : ''
        const comma = result.indexOf(',')
        if (comma === -1) return
        addImage(result.slice(comma + 1), mimeType)
      }
      reader.onerror = () => {
        if (useAppStore.getState().currentSessionId === currentSessionId) setImageError('readFailed')
      }
      reader.readAsDataURL(file)
    }
  }

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // Guard the pathological case first: a multi-megabyte paste freezes the
    // autosize/streaming pipeline. Keep the head, drop the rest, say so.
    const pastedText = e.clipboardData?.getData('text/plain') ?? ''
    if (pastedText.length > MAX_PASTE_CHARS) {
      e.preventDefault()
      const el = textareaRef.current
      const start = el?.selectionStart ?? text.length
      const end = el?.selectionEnd ?? text.length
      const clipped = `${pastedText.slice(0, MAX_PASTE_CHARS)}…`
      const next = `${text.slice(0, start)}${clipped}${text.slice(end)}`
      commitDraft(next)
      setCaret(start + clipped.length)
      showNotice('composer.pasteTruncated')
      return
    }
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
    // A box-selected pile of 200 files is almost never intentional; the
    // message would carry 200 @path lines. Cap the total and say so.
    setPendingFiles((prev) => {
      const next = [...prev]
      let added = false
      let skipped = 0
      for (const att of resolved) {
        if (next.some((p) => p.path === att.path)) continue
        if (next.length >= MAX_FILE_ITEMS) {
          skipped += 1
          continue
        }
        next.push(att)
        added = true
      }
      if (skipped > 0) showNotice('composer.tooManyFiles')
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

  // Images selected in the general picker use the same multimodal input as a paste.
  const handleAttachFile = async () => {
    const sessionIdAtAction = currentSessionId
    const filePath = await window.electronAPI.selectComposerAttachment()
    if (!filePath || useAppStore.getState().currentSessionId !== sessionIdAtAction) return
    if (typeof filePath !== 'string') {
      if (filePath.ok) addImage(filePath.data, filePath.mimeType)
      else setImageError(filePath.error)
      return
    }
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
    latest.touchSession(sessionId)
    latest.setSessionError(sessionId, null)
    return true
  }

  const outgoingText = () => text.trim() || (images.length ? t('composer.imageOnlyPrompt') : '')
  const handleSend = () => {
    const trimmed = outgoingText()
    if (!trimmed || disabled || activeReaders.current.size) return
    if (trimmed === '/compact' && onCompact && !images.length && !pendingFiles.length) {
      if (compactUnavailable) return
      commitDraft('')
      setCaret(0)
      onCompact()
      return
    }
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
      let target = sessionIdAtSend ?? NEW_CHAT_DRAFT_KEY
      clearComposerDraft(target)
      let clearedVersion = useAppStore.getState().getComposerDraftVersion(target)
      const restore = (ok: void | boolean) => {
        if (ok !== false) return
        const store = useAppStore.getState()
        if (store.getComposerDraftVersion(target) !== clearedVersion ||
            (target !== NEW_CHAT_DRAFT_KEY && !store.sessions.some((session) => session.id === target))) return
        setComposerDraft(target, {
          text,
          images: toPromptImages(stagedImagesSnapshot),
          files: toDraftFiles(staged)
        })
        if ((store.currentSessionId ?? NEW_CHAT_DRAFT_KEY) !== target) return
        setText(text)
        setImages(stagedImagesSnapshot)
        setPendingFiles(staged)
        setCaret(text.length)
      }
      if (!sessionIdAtSend || useAppStore.getState().currentSessionId === sessionIdAtSend) {
        clearLocalDraft()
      }
      try {
        void Promise.resolve(onSend(outgoing, imgs, (sessionId) => {
          if (target === sessionId) return
          target = sessionId
          clearedVersion = useAppStore.getState().getComposerDraftVersion(target)
        })).then(restore, () => restore(false))
      } catch {
        restore(false)
      }
      return
    }
    clearComposerDraft(sessionIdAtSend ?? NEW_CHAT_DRAFT_KEY)
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
    const trimmed = outgoingText()
    if (!sessionId || !trimmed || disabled || activeReaders.current.size || !busy) return
    const staged = images
    const stagedFiles = pendingFiles
    const imgs = stagedImages()
    const outgoing = appendAttachmentRefs(trimmed, stagedFiles)
    const store = useAppStore.getState()
    store.clearComposerDraft(sessionId)
    const clearedVersion = store.getComposerDraftVersion(sessionId)
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
      latest.setSessionError(sessionId, steerFailureKey(result.source))
      if (latest.getComposerDraftVersion(sessionId) !== clearedVersion) return
      latest.setComposerDraft(sessionId, {
        text,
        images: toPromptImages(staged),
        files: toDraftFiles(stagedFiles)
      })
      if (latest.currentSessionId !== sessionId) return
      setText(text)
      setImages(staged)
      setPendingFiles(stagedFiles)
      setCaret(text.length)
    })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z' &&
        document.execCommand(e.shiftKey ? 'redo' : 'undo')) {
      e.preventDefault()
      return
    }
    if (atOpen) {
      if (e.key === 'ArrowDown' && mentionCount > 0) {
        e.preventDefault()
        // Advance from the CURRENT index (clamped), not the render-time copy —
        // two keydowns before a re-render must move two steps.
        setAtMenuIndex((i) => (Math.min(i, mentionCount - 1) + 1) % mentionCount)
        return
      }
      if (e.key === 'ArrowUp' && mentionCount > 0) {
        e.preventDefault()
        setAtMenuIndex((i) => (Math.min(i, mentionCount - 1) - 1 + mentionCount) % mentionCount)
        return
      }
      if (
        !e.shiftKey && (e.key === 'Tab' || e.key === 'Enter') && mentionCount > 0
      ) {
        e.preventDefault()
        pickMention(activeMentionIndex)
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

  const canSend = !disabled && !readingImages && Boolean(text.trim() || images.length)
  const destination = currentWorkspace && currentWorkspace.source !== 'default'
    ? t('composer.destinationProject', {
        name: projects.find(project => project.path === currentWorkspace.realPath)?.name
          || basename(currentWorkspace.displayPath) || currentWorkspace.displayPath
      })
    : t('composer.trayDefault')
  const stopLabel = stopping
    ? t('chat.stopping')
    : queue.length > 0 ? t('composer.stopWithQueue', { count: queue.length }) : t('composer.stop')

  const panelPosition = currentSessionId ? 'bottom-full mb-2' : 'top-full mt-2'
  const panelAnchorRef = useRef<HTMLDivElement>(null)
  const [panelMax, setPanelMax] = useState<number | null>(null)
  const panelsOpen = slashQuery !== null || atOpen
  useEffect(() => {
    if (!panelsOpen) return
    const measure = () => {
      const el = panelAnchorRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const room = currentSessionId ? rect.top : window.innerHeight - rect.bottom
      setPanelMax(Math.max(64, Math.round(room - 12)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (panelAnchorRef.current) observer.observe(panelAnchorRef.current)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [panelsOpen, currentSessionId])


  return (
    <ComposerMenuPlacement.Provider value={currentSessionId ? 'top' : 'below'}>
    <div className={currentSessionId ? 'shrink-0 px-4 pb-1 pt-1' : 'agent-home-composer'}>
      <div ref={panelAnchorRef} className={`relative mx-auto w-full ${currentSessionId ? 'max-w-[760px]' : 'max-w-[776px]'}`}>
        {slashQuery !== null && (
          <div
            className={`absolute ${panelPosition} left-0 right-0 z-20 overflow-y-auto overflow-x-hidden rounded-xl border border-line bg-ink-850 p-1 shadow-pop`}
            style={panelMax !== null ? { maxHeight: panelMax } : undefined}
          >
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
                        disabled={item.builtin && compactUnavailable}
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
                            {item.builtin && compactUnavailable ? t(compacting ? 'usage.compacting' : 'usage.waitForTurn') : item.description}
                            {item.builtin && currentSessionId && <> · <ContextReadout sessionId={currentSessionId} /></>}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 font-mono text-[9.5px] uppercase tracking-wider text-cream-faint">
                          {item.builtin
                            ? t('composer.slashBuiltin')
                            : item.source === 'app'
                              ? t('composer.slashApp')
                              : item.source}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        )}
        {atOpen && (
          <div
            id={mentionMenuId}
            role="listbox"
            aria-label={t('composer.atMenu')}
            className={`absolute ${panelPosition} left-0 right-0 z-20 max-h-72 overflow-y-auto rounded-xl border border-line bg-ink-850 p-1 shadow-pop`}
            style={panelMax !== null ? { maxHeight: Math.min(panelMax, 288) } : undefined}
          >
            <div role="group" aria-label={t('composer.atMcpTitle')}>
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-faint">
                {t('composer.atMcpTitle')}
              </div>
              {mcpItems.map((name, i) => (
                <button
                  key={name}
                  id={`${mentionMenuId}-${i}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === activeMentionIndex}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setAtMenuIndex(i)}
                  onClick={() => pickMention(i)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                    i === activeMentionIndex ? 'bg-overlay-strong' : ''
                  }`}
                >
                  <Plug size={13} className="shrink-0 text-accent" />
                  <span className="min-w-0 truncate text-[12px] text-cream">{name}</span>
                </button>
              ))}
              {mcpItems.length === 0 && (
                <div className="px-2.5 py-2 text-[12px] text-cream-faint">
                  {t(mcpStatus === 'loading' ? 'composer.atLoading' : mcpStatus === 'error' ? 'composer.atMcpError' : 'composer.atMcpEmpty')}
                </div>
              )}
            </div>
            {!mcpOnly && (
              <div role="group" aria-label={t('composer.atTitle')}>
                <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-faint">
                  {t('composer.atTitle')}
                </div>
                {fileItems.map((f, i) => {
                  const index = mcpItems.length + i
                  const slash = f.lastIndexOf('/')
                  const dir = slash === -1 ? '' : f.slice(0, slash)
                  const name = slash === -1 ? f : f.slice(slash + 1)
                  return (
                    <button
                      key={f}
                      id={`${mentionMenuId}-${index}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === activeMentionIndex}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setAtMenuIndex(index)}
                      onClick={() => pickMention(index)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                        index === activeMentionIndex ? 'bg-overlay-strong' : ''
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
                })}
                {fileItems.length === 0 && (
                  <div className="px-2.5 py-2 text-[12px] text-cream-faint">
                    {t(!workspaceId ? 'composer.atNeedProject' : !projectFiles ? 'composer.atLoading' : projectFiles.length ? 'composer.noFiles' : 'composer.workspaceEmpty')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* Home wraps the white card plus the connected gray tray in one
            combination (design.md 5.2); sessions render the bare card. */}
        <div className={currentSessionId ? undefined : 'entry-composer'}>
        <div
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          data-dropping={dropping || undefined}
          data-disabled={disabled || undefined}
          className={`composer-shell relative border transition-[border-color,box-shadow] duration-150 ${currentSessionId ? 'chat-composer' : 'home-composer'}`}
        >
          {dropping && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[16px] bg-ink-950/45">
              <div className="flex items-center gap-1.5 rounded-full border border-accent/50 bg-ink-900 px-3 py-1 text-[11px] font-medium text-cream-dim shadow-pop">
                <ImageIcon size={12} className="text-accent" />
                <span>{t('composer.dropHint')}</span>
              </div>
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
                    disabled={!busy || stopping || queuePaused || dispatchingId === m.id || steeringQueuedId === m.id}
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
                    disabled={dispatchingId === m.id || steeringQueuedId === m.id}
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
                  <AttachedImage image={img} previewUrl={img.previewUrl} />
                  <button
                    onClick={() => commitDraft(text, images.filter(item => item.id !== img.id))}
                    title={t('composer.removeImage')}
                    aria-label={t('composer.removeImage')}
                    className="focus-ring absolute right-0.5 top-0.5 rounded-full bg-ink-950/85 p-0.5 text-cream-faint transition-colors hover:text-cream"
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
            onFocus={() => { if (invokeOpen) setInvokeTarget(null) }}
            aria-haspopup="listbox"
            aria-controls={atOpen ? mentionMenuId : undefined}
            aria-activedescendant={activeMentionIndex >= 0 ? `${mentionMenuId}-${activeMentionIndex}` : undefined}
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
                  : currentSessionId
                    ? t('composer.placeholderSession')
                    : t('composer.homePlaceholder')
            }
            rows={1}
            className="max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent px-2.5 py-1.5 text-[15px] leading-6 text-cream placeholder-cream-faint outline-none"
          />
          <div className="composer-toolbar flex items-center justify-between gap-2 px-1 pb-0.5 pt-0.5">
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <button
                  ref={addButtonRef}
                  onClick={() => {
                    if (invokeOpen) setInvokeTarget(null)
                    else setAddMenuOpen((open) => !open)
                  }}
                  title={t('composer.addContent')}
                  aria-label={t('composer.addContent')}
                  aria-haspopup="menu"
                  aria-expanded={addMenuOpen || (invokeOpen && invokeTarget?.anchor === 'plus')}
                  className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-cream-dim transition-colors hover:bg-overlay hover:text-cream"
                >
                  <Plus size={14} />
                </button>
                <MenuPortal
                  open={addMenuOpen}
                  triggerRef={addButtonRef}
                  onClose={() => setAddMenuOpen(false)}
                  width={176}
                  initialFocusRef={firstAddActionRef}
                >
                  <button
                    ref={firstAddActionRef}
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
                  <button
                    onClick={() => {
                      setAddMenuOpen(false)
                      setInvokeTarget({ sessionId: currentSessionId, workspaceId, anchor: 'plus' })
                    }}
                    disabled={disabled}
                    className="focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay disabled:opacity-60"
                  >
                    <Sparkles size={13} className="shrink-0 text-accent" />
                    {t('composer.invoke.open')}
                  </button>
                </MenuPortal>
              </div>
              {invokeOpen && (
                <InvokePicker
                  triggerRef={invokeTarget?.anchor === 'tray' ? pluginButtonRef : addButtonRef}
                  tray={invokeTarget?.anchor === 'tray'}
                  onClose={() => setInvokeTarget(null)}
                  onPick={pickInvocation}
                  commands={commands}
                  liveSession={currentSessionId !== null}
                />
              )}
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
              <div className="composer-model-control">
                <ModelThinkingPicker sessionId={currentSessionId} compact={compact} />
              </div>
              {busy ? (
                <div className="flex items-center gap-1.5">
                  {canSend && (
                    <>
                      <button
                        onClick={handleSend}
                        title={t('composer.queueHint')}
                        aria-label={`${t('composer.queue')} · ${t('composer.queueHint')}`}
                        className={`focus-ring flex h-8 items-center gap-1.5 rounded-full bg-overlay-strong text-[11px] font-medium text-cream-dim transition-colors duration-150 hover:bg-overlay hover:text-cream ${
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
                        className={`focus-ring flex h-8 items-center gap-1.5 rounded-full bg-accent text-[11px] font-medium text-[rgb(var(--bg-app))] transition-colors duration-150 hover:bg-accent-bright ${
                          compact ? 'w-8 justify-center' : 'px-2.5'
                        }`}
                      >
                        <Zap size={13} strokeWidth={2.5} />
                        {!compact && <span>{t('composer.steerNow')}</span>}
                      </button>
                    </>
                  )}
                  <MagneticButton
                    onClick={onStop}
                    disabled={stopping}
                    title={stopLabel}
                    aria-label={stopLabel}
                    className={`focus-ring h-8 w-8 rounded-full bg-cream text-ink-950 transition-colors duration-150 hover:opacity-85 ${stopping ? 'cursor-wait opacity-70' : ''}`}
                    glow={false}
                  >
                    {stopping ? <Loader2 size={13} className="animate-spin" /> : <Square size={11} fill="currentColor" />}
                  </MagneticButton>
                </div>
              ) : (
                <MagneticButton
                  onClick={handleSend}
                  disabled={!canSend}
                  title={t('composer.send')}
                  aria-label={t('composer.send')}
                  className={`composer-send focus-ring h-[36px] w-[36px] shrink-0 rounded-full transition-colors duration-150 ${
                    canSend
                      ? 'bg-accent text-[rgb(var(--bg-app))] hover:bg-accent-bright'
                      : 'cursor-not-allowed bg-overlay-strong text-cream-faint'
                  }`}
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </MagneticButton>
              )}
            </div>
          </div>
        </div>
          {!currentSessionId && (
            <div className="composer-tray">
              <button
                ref={projectButtonRef}
                type="button"
                onClick={() => {
                  setProjectMenuOpen((v) => !v)
                }}
                title={currentWorkspace?.displayPath ?? destination}
                aria-label={t('composer.chooseDestination', { destination })}
                aria-haspopup="menu"
                aria-expanded={projectMenuOpen}
                className="focus-ring"
              >
                <Folder size={15} className="shrink-0" aria-hidden="true" />
                <span className="max-w-[180px] truncate">
                  {destination}
                </span>
                <ChevronDown
                  size={12}
                  className={`shrink-0 transition ${projectMenuOpen ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>
              <MenuPortal open={projectMenuOpen} triggerRef={projectButtonRef} onClose={() => setProjectMenuOpen(false)} width={300}>
                <ProjectPicker onDone={() => { setProjectMenuOpen(false); projectButtonRef.current?.focus() }} />
              </MenuPortal>
              {currentWorkspace?.source !== 'default' && gitInfo && (
                <span
                  title={gitInfo.branch}
                  className="flex min-w-0 items-center gap-1 text-[12px] text-cream-faint"
                >
                  <GitBranch size={12} className="shrink-0" aria-hidden="true" />
                  <span className="max-w-[140px] truncate font-mono">{gitInfo.branch}</span>
                </span>
              )}
              <button
                type="button"
                ref={pluginButtonRef}
                aria-haspopup="listbox"
                aria-expanded={invokeOpen && invokeTarget?.anchor === 'tray'}
                disabled={disabled}
                onClick={() => setInvokeTarget(invokeOpen && invokeTarget?.anchor === 'tray' ? null : { sessionId: currentSessionId, workspaceId, anchor: 'tray' })}
                className="focus-ring"
              >
                <Layers size={14} className="shrink-0" aria-hidden="true" />
                <span>{t('composer.trayPlugins')}</span>
              </button>
            </div>
          )}
        </div>
        {currentSessionId && <UsageMonitor key={currentSessionId} sessionId={currentSessionId}
          onCompact={onCompact} disabled={disabled || stopping} />}
      </div>
    </div>
    </ComposerMenuPlacement.Provider>
  )
})

/**
 * Memoized: ChatPanel re-renders on every streaming delta; the composer's
 * props (primitives + ChatPanel-stabilized callbacks) do not change then, so
 * the whole input surface — pickers included — skips those renders. Typing
 * latency depends on this: the textarea must not re-render on unrelated
 * store churn.
 */
