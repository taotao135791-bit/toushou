import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Code2,
  FileText,
  FolderOpen,
  Import,
  Library,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Trash2,
  Github,
  TriangleAlert,
  X
} from 'lucide-react'
import { GithubSkillFile, GithubSkillSource, Session, SkillEntry } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { formatRelativeTime } from '../lib/time'
import { launchSkillSession } from '../lib/launchTool'
import { formatSkillChatMessage, formatSkillChatReference } from '@shared/skills'
import Markdown from '../components/Markdown'

/**
 * SKILL 目录 — the team library of self-made assets. Markdown docs open in
 * an in-page viewer (sandboxed renderer); single-file HTML tools are served
 * by Main over loopback and open in the hardened browser panel. The page is
 * deliberately read-mostly for sharing (import copies a picked file in);
 * Markdown cards can also launch a new chat with the SOP auto-sent.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function SkillsPage() {
  const t = useT()
  const navigate = useNavigate()
  const language = useAppStore((s) => s.language)
  const [entries, setEntries] = useState<SkillEntry[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importFailed, setImportFailed] = useState(false)
  const [viewer, setViewer] = useState<{ entry: SkillEntry; content: string } | null>(null)
  const [viewerFailed, setViewerFailed] = useState(false)
  const [githubOpen, setGithubOpen] = useState(false)
  const [githubUrl, setGithubUrl] = useState('')
  const [githubBusy, setGithubBusy] = useState(false)
  const [githubError, setGithubError] = useState<string | null>(null)
  const [githubPreview, setGithubPreview] = useState<{
    source: GithubSkillSource
    files: GithubSkillFile[]
  } | null>(null)
  const [githubSelected, setGithubSelected] = useState<Set<string>>(new Set())
  const [githubDone, setGithubDone] = useState<{ imported: number; skipped: number } | null>(null)
  const [launchingId, setLaunchingId] = useState<string | null>(null)
  const [picker, setPicker] = useState<SkillEntry | null>(null)
  const [deleting, setDeleting] = useState<SkillEntry | null>(null)
  const [deleteFailed, setDeleteFailed] = useState(false)
  const sessions = useAppStore((s) => s.sessions)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => {
    window.electronAPI
      .listSkills()
      .then((result) => {
        if (result.ok) {
          setEntries(result.entries)
          setLoadFailed(false)
        } else {
          setEntries([])
          setLoadFailed(true)
        }
      })
      .catch(() => {
        setEntries([])
        setLoadFailed(true)
      })
  }, [])

  useEffect(() => {
    refresh()
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    }
  }, [refresh])

  // Re-list when the page becomes visible again: colleagues sync the shared
  // folder with git outside the app, so focus is the natural refresh signal.
  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const flashNotice = (setter: (value: boolean) => void) => {
    setter(true)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setter(false), 4000)
  }

  const handleImport = async () => {
    if (importing) return
    try {
      const grant = await window.electronAPI.selectSkillFile()
      if (!grant) return
      setImporting(true)
      setImportFailed(false)
      const result = await window.electronAPI.importSkill(grant.id)
      if (!result.ok) {
        flashNotice(setImportFailed)
      } else {
        refresh()
      }
    } catch {
      flashNotice(setImportFailed)
    } finally {
      setImporting(false)
    }
  }

  const openSkill = async (entry: SkillEntry) => {
    if (entry.kind === 'html') {
      const result = await window.electronAPI.openSkillHtml(entry.id)
      if (result.ok) {
        navigate(`/browser?url=${encodeURIComponent(result.url)}`)
      } else {
        flashNotice(setViewerFailed)
      }
      return
    }
    const result = await window.electronAPI.readSkill(entry.id)
    if (result.ok) {
      setViewer({ entry: result.entry, content: result.content })
    } else {
      flashNotice(setViewerFailed)
    }
  }

  const useInChat = async (entry: SkillEntry) => {
    if (entry.kind !== 'markdown' || launchingId) return
    setLaunchingId(entry.id)
    try {
      // Main injects the SOP into the session system prompt; the composer
      // auto-sends only this short reference line.
      const reference = formatSkillChatReference(entry.name, language)
      const id = await launchSkillSession(entry.id, reference)
      if (id) navigate('/')
    } catch {
      flashNotice(setViewerFailed)
    } finally {
      setLaunchingId(null)
    }
  }

  /** Send the SOP into an existing session: injection is impossible there
   * (the process already runs), so the structured full text rides as a
   * normal message through the composer's autosend path. */
  const sendToSession = async (entry: SkillEntry, sessionId: string) => {
    if (entry.kind !== 'markdown' || launchingId) return
    setLaunchingId(entry.id)
    try {
      const result = await window.electronAPI.readSkill(entry.id)
      if (!result.ok) {
        flashNotice(setViewerFailed)
        return
      }
      const message = formatSkillChatMessage(entry.name, result.content, language)
      const store = useAppStore.getState()
      store.setCurrentSessionId(sessionId)
      store.setComposerPrefill(message)
      store.setComposerAutosend(true)
      setViewer(null)
      setPicker(null)
      navigate('/')
    } catch {
      flashNotice(setViewerFailed)
    } finally {
      setLaunchingId(null)
    }
  }

  /** Deleting is destructive, so the card only arms this confirmation —
   * the actual unlink happens in Main after the id passes the same
   * isValidSkillId guard every skill operation uses. */
  const confirmDelete = async () => {
    if (!deleting) return
    const target = deleting
    setDeleting(null)
    try {
      const api = window.electronAPI
      // A stale window (preload older than the renderer bundle) must fail
      // loudly here instead of silently dropping the click.
      if (typeof api.deleteSkill !== 'function') throw new Error('deleteSkill unavailable')
      const result = await api.deleteSkill(target.id)
      if (!result.ok) {
        flashNotice(setDeleteFailed)
        return
      }
      if (viewer?.entry.id === target.id) setViewer(null)
      refresh()
    } catch {
      flashNotice(setDeleteFailed)
    }
  }

  const githubErrorText = (error: string): string => {
    if (error === 'invalid-url') return t('skills.github.error.invalidUrl')
    if (error === 'no-files') return t('skills.github.error.noFiles')
    if (error === 'rate-limited') return t('skills.github.error.rateLimited')
    if (error === 'repo-not-found') return t('skills.github.error.notFound')
    if (error === 'unavailable') return t('skills.github.error.unavailable')
    return t('skills.github.error.network')
  }

  const handleGithubPreview = async () => {
    if (githubBusy) return
    setGithubBusy(true)
    setGithubError(null)
    setGithubPreview(null)
    setGithubDone(null)
    try {
      const preview = window.electronAPI.previewGithubSkills
      if (typeof preview !== 'function') {
        setGithubError('unavailable')
        return
      }
      const result = await preview(githubUrl)
      if (result.ok) {
        setGithubPreview({ source: result.source, files: result.files })
        setGithubSelected(new Set(result.files.map((f) => f.path)))
      } else {
        setGithubError(result.error)
      }
    } catch {
      setGithubError('unavailable')
    } finally {
      setGithubBusy(false)
    }
  }

  const handleGithubImport = async () => {
    if (!githubPreview || githubBusy || githubSelected.size === 0) return
    setGithubBusy(true)
    setGithubError(null)
    try {
      const importer = window.electronAPI.importGithubSkills
      if (typeof importer !== 'function') {
        setGithubError('unavailable')
        return
      }
      const result = await importer({
        source: githubPreview.source,
        paths: Array.from(githubSelected)
      })
      if (result.ok) {
        setGithubDone({ imported: result.imported.length, skipped: result.skipped.length })
        if (result.imported.length > 0) refresh()
      } else {
        setGithubError(result.error === 'rate-limited' ? 'rate-limited' : 'network-failed')
      }
    } catch {
      setGithubError('unavailable')
    } finally {
      setGithubBusy(false)
    }
  }

  const loading = entries === null

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <header className="app-drag relative z-30 flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <Library size={15} className="shrink-0 text-accent" />
        <span className="shrink-0 text-[13px] font-medium text-cream">{t('skills.title')}</span>
        <span className="hidden min-w-0 truncate text-[12px] text-cream-faint md:block">
          {t('skills.subtitle')}
        </span>
        <div className="app-no-drag ml-auto flex shrink-0 items-center gap-1">
          <button
            onClick={refresh}
            title={t('skills.refresh')}
            className="rounded-lg border border-transparent p-1.5 text-cream-faint transition hover:bg-overlay hover:text-cream"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={() => void window.electronAPI.revealSkills()}
            title={t('skills.reveal')}
            className="rounded-lg border border-transparent p-1.5 text-cream-faint transition hover:bg-overlay hover:text-cream"
          >
            <FolderOpen size={14} />
          </button>
          <button
            onClick={handleImport}
            disabled={importing}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream transition hover:border-accent/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {importing ? <Loader2 size={13} className="animate-spin" /> : <Import size={13} />}
            {importing ? t('skills.importing') : t('skills.import')}
          </button>
          <button
            onClick={() => {
              setGithubOpen(true)
              setGithubUrl('')
              setGithubError(null)
              setGithubPreview(null)
              setGithubDone(null)
            }}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[12px] text-cream transition hover:border-accent/40"
          >
            <Github size={13} />
            {t('skills.github')}
          </button>
        </div>
      </header>

      {(loadFailed || importFailed || viewerFailed || deleteFailed) && (
        <div className="mx-4 mt-3 rounded-lg border border-yellow-500/25 bg-yellow-500/10 px-3 py-2 text-xs leading-5 text-yellow-700 dark:text-yellow-200/90">
          {loadFailed
            ? t('skills.error.load')
            : importFailed
              ? t('skills.error.import')
              : viewerFailed
                ? t('skills.error.read')
                : t('skills.error.delete')}
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-cream-faint">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Library size={28} className="text-cream-faint" />
            <p className="text-[13px] font-medium text-cream">{t('skills.empty.title')}</p>
            <p className="max-w-sm text-[12px] leading-5 text-cream-faint">
              {t('skills.empty.desc')}
            </p>
            <p className="max-w-sm text-[11px] leading-5 text-cream-faint opacity-70">
              {t('skills.empty.hint')}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-col items-start gap-2 rounded-xl border border-line bg-ink-850 p-4 text-left shadow-card transition hover:border-accent/40"
              >
                <button
                  type="button"
                  onClick={() => void openSkill(entry)}
                  className="flex w-full flex-1 flex-col items-start gap-2 text-left"
                >
                <div className="flex w-full items-center gap-2">
                  {entry.kind === 'html' ? (
                    <Code2 size={14} className="shrink-0 text-accent" />
                  ) : (
                    <FileText size={14} className="shrink-0 text-accent" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-cream">
                    {entry.name}
                  </span>
                  <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] tracking-wide text-cream-faint">
                    {entry.kind === 'html' ? t('skills.kind.html') : t('skills.kind.markdown')}
                  </span>
                </div>
                {entry.description && (
                  <p className="line-clamp-2 w-full text-[12px] leading-5 text-cream-faint">
                    {entry.description}
                  </p>
                )}
                <p className="mt-auto flex w-full items-center gap-1.5 text-[11px] text-cream-faint opacity-80">
                  {entry.author && <span className="max-w-[10rem] truncate">{entry.author}</span>}
                  {entry.author && <span>·</span>}
                  <span>{formatSize(entry.sizeBytes)}</span>
                  <span>·</span>
                  <span>{formatRelativeTime(entry.updatedAtMillis, language)}</span>
                </p>
                </button>
                <div className="mt-1 flex w-full items-center gap-2">
                {entry.kind === 'markdown' && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      setPicker(entry)
                    }}
                    disabled={launchingId !== null}
                    className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[11px] text-cream transition hover:border-accent/40 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {launchingId === entry.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : null}
                    {t('skills.useInChat')}
                  </button>
                )}
                  <button
                    type="button"
                    aria-label={t('skills.delete')}
                    onClick={(event) => {
                      event.stopPropagation()
                      setDeleting(entry)
                    }}
                    className="ml-auto flex items-center rounded-lg border border-line p-1.5 text-cream-faint transition hover:border-red-400/40 hover:text-red-300"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {viewer && (
        <div className="absolute inset-0 z-40 flex flex-col bg-ink-950/80 backdrop-blur-sm">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
            <FileText size={15} className="shrink-0 text-accent" />
            <span className="min-w-0 truncate text-[13px] font-medium text-cream">
              {viewer.entry.name}
            </span>
            {viewer.entry.kind === 'markdown' && (
              <button
                type="button"
                onClick={() => setPicker(viewer.entry)}
                disabled={launchingId !== null}
                className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-cream transition hover:border-accent/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {launchingId === viewer.entry.id ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : null}
                {t('skills.useInChat')}
              </button>
            )}
            <button
              onClick={() => setViewer(null)}
              className="ml-auto rounded-lg border border-transparent p-1.5 text-cream-faint transition hover:bg-overlay hover:text-cream"
            >
              <X size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <div className="mx-auto max-w-3xl text-[13px] text-cream-dim">
              <Markdown content={viewer.content} />
            </div>
          </div>
        </div>
      )}

      {githubOpen && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm">
          <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-ink-900 shadow-card">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
              <Github size={15} className="shrink-0 text-accent" />
              <span className="text-[13px] font-medium text-cream">{t('skills.github.title')}</span>
              <button
                onClick={() => setGithubOpen(false)}
                className="ml-auto rounded-lg border border-transparent p-1.5 text-cream-faint transition hover:bg-overlay hover:text-cream"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={githubUrl}
                  onChange={(e) => setGithubUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleGithubPreview()
                  }}
                  placeholder={t('skills.github.placeholder')}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-ink-850 px-3 py-2 text-[12px] text-cream outline-none transition placeholder:text-cream-faint focus:border-accent/50"
                />
                <button
                  onClick={handleGithubPreview}
                  disabled={githubBusy || githubUrl.trim().length === 0}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-ink-850 px-3 py-2 text-[12px] text-cream transition hover:border-accent/40 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {githubBusy && !githubPreview ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : null}
                  {githubBusy && !githubPreview
                    ? t('skills.github.previewing')
                    : t('skills.github.preview')}
                </button>
              </div>

              {githubError && (
                <p className="rounded-lg border border-yellow-500/25 bg-yellow-500/10 px-3 py-2 text-[12px] leading-5 text-yellow-700 dark:text-yellow-200/90">
                  {githubErrorText(githubError)}
                </p>
              )}

              {githubPreview && (
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] text-cream-faint">
                    {t('skills.github.fileCount', { count: githubPreview.files.length })}
                  </p>
                  <div className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line">
                    {githubPreview.files.map((file) => (
                      <label
                        key={file.path}
                        className="flex cursor-pointer items-center gap-2 bg-ink-850 px-3 py-2 text-[12px] text-cream hover:bg-overlay"
                      >
                        <input
                          type="checkbox"
                          checked={githubSelected.has(file.path)}
                          onChange={(e) => {
                            const next = new Set(githubSelected)
                            if (e.target.checked) {
                              next.add(file.path)
                            } else {
                              next.delete(file.path)
                            }
                            setGithubSelected(next)
                          }}
                          className="accent-accent"
                        />
                        <span className="min-w-0 flex-1 truncate">{file.path}</span>
                        <span className="shrink-0 text-[10px] text-cream-faint">
                          {file.kind === 'html' ? t('skills.kind.html') : t('skills.kind.markdown')}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {githubDone && (
                <p className="rounded-lg border border-line bg-overlay px-3 py-2 text-[12px] leading-5 text-cream-dim">
                  {t('skills.github.importDone', {
                    imported: githubDone.imported,
                    skipped: githubDone.skipped
                  })}
                </p>
              )}
            </div>
            {githubPreview && (
              <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-line px-4">
                <button
                  onClick={handleGithubImport}
                  disabled={githubBusy || githubSelected.size === 0}
                  className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-[12px] text-cream transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {githubBusy ? <Loader2 size={13} className="animate-spin" /> : null}
                  {githubBusy ? t('skills.github.importing') : t('skills.github.import')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {picker && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm">
          <div className="flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-line bg-ink-900 shadow-card">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
              <MessageSquare size={15} className="shrink-0 text-accent" />
              <span className="min-w-0 truncate text-[13px] font-medium text-cream">
                {t('skills.pick.title')}
              </span>
              <button
                onClick={() => setPicker(null)}
                className="ml-auto rounded-lg border border-transparent p-1.5 text-cream-faint transition hover:bg-overlay hover:text-cream"
              >
                <X size={14} />
              </button>
            </div>
            <p className="px-4 pt-3 text-[11px] leading-5 text-cream-faint">
              {t('skills.pick.hint')}
            </p>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
              <button
                type="button"
                disabled={launchingId !== null}
                onClick={() => {
                  const entry = picker
                  setPicker(null)
                  if (entry) void useInChat(entry)
                }}
                className="flex w-full items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2.5 text-left transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {launchingId === picker.id ? (
                  <Loader2 size={14} className="animate-spin text-accent" />
                ) : (
                  <Plus size={14} className="shrink-0 text-accent" />
                )}
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-cream">
                  {t('skills.pick.new')}
                </span>
              </button>
              <p className="px-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-cream-faint">
                {t('skills.pick.existing')}
              </p>
              {sessions.length === 0 ? (
                <p className="px-1 py-2 text-[11px] text-cream-faint">{t('skills.pick.empty')}</p>
              ) : (
                sessions.map((session: Session) => (
                  <button
                    key={session.id}
                    type="button"
                    disabled={launchingId !== null}
                    onClick={() => void sendToSession(picker, session.id)}
                    className="flex w-full items-center gap-2 rounded-lg border border-line bg-ink-800/50 px-3 py-2.5 text-left transition hover:border-ink-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {launchingId === picker.id ? (
                      <Loader2 size={14} className="animate-spin text-cream-faint" />
                    ) : (
                      <MessageSquare size={14} className="shrink-0 text-cream-faint" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[12px] text-cream">
                      {session.title || t('skills.pick.untitled')}
                    </span>
                    <span className="shrink-0 text-[10px] text-cream-faint">
                      {formatRelativeTime(session.createdAt, language)}
                    </span>
                  </button>
                ))
              )}
           </div>
         </div>
       </div>
     )}
      {deleting && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm">
          <div className="flex w-full max-w-sm flex-col overflow-hidden rounded-xl border border-line bg-ink-900 shadow-card">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <TriangleAlert size={15} className="shrink-0 text-red-400" />
              <span className="text-[13px] font-medium text-cream">{t('skills.deleteTitle')}</span>
            </div>
            <p className="px-4 py-3 text-[12px] leading-5 text-cream-faint">
              {t('skills.deleteConfirm', { name: deleting.name })}
            </p>
            <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
              <button
                type="button"
                onClick={() => setDeleting(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream transition hover:border-ink-600"
              >
                {t('skills.deleteCancel')}
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                className="flex items-center gap-1.5 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300 transition hover:bg-red-500/20"
              >
                <Trash2 size={12} />
                {t('skills.deleteAction')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
