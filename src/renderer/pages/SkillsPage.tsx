import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Code2,
  FileText,
  FolderOpen,
  Import,
  Library,
  Loader2,
  RefreshCw,
  Github,
  X
} from 'lucide-react'
import { GithubSkillFile, GithubSkillSource, SkillEntry } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { formatRelativeTime } from '../lib/time'
import Markdown from '../components/Markdown'

/**
 * SKILL 目录 — the team library of self-made assets. Markdown docs open in
 * an in-page viewer (sandboxed renderer); single-file HTML tools are served
 * by Main over loopback and open in the hardened browser panel. The page is
 * deliberately read-mostly: sharing itself happens through the folder (for
 * example a shared git clone), and import copies a picked file in.
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

      {(loadFailed || importFailed || viewerFailed) && (
        <div className="mx-4 mt-3 rounded-lg border border-yellow-500/25 bg-yellow-500/10 px-3 py-2 text-xs leading-5 text-yellow-700 dark:text-yellow-200/90">
          {loadFailed
            ? t('skills.error.load')
            : importFailed
              ? t('skills.error.import')
              : t('skills.error.read')}
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
              <button
                key={entry.id}
                onClick={() => void openSkill(entry)}
                className="flex flex-col items-start gap-2 rounded-xl border border-line bg-ink-850 p-4 text-left shadow-card transition hover:border-accent/40"
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
    </div>
  )
}
