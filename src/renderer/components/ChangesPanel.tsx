import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, FileDiff, Loader2, RefreshCw } from 'lucide-react'
import { GitFileChange } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { useGitInfo } from '../lib/useGitInfo'
import { WorkspaceRequestFence } from '../lib/workspaceRequest'

const STATUS_DOT: Record<GitFileChange['status'], string> = {
  M: 'bg-amber-500',
  A: 'bg-emerald-500',
  D: 'bg-red-500',
  untracked: 'bg-cream-faint/50'
}

export function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'bg-overlay text-cream-faint'
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++')
  ) {
    return 'text-cream-faint'
  }
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-600 dark:text-red-300'
  return 'text-cream-dim'
}

export default function ChangesPanel() {
  const t = useT()
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const { info, refresh } = useGitInfo()
  const [diffView, setDiffView] = useState<{ path: string; text: string } | null>(null)
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null)
  const [diffFailed, setDiffFailed] = useState<string | null>(null)
  const requestFence = useRef(new WorkspaceRequestFence()).current

  // Keep the active workspace current before effects run so a late diff from
  // the previous project cannot overwrite this panel during a project switch.
  requestFence.setWorkspace(currentWorkspace?.id ?? null)

  useEffect(() => {
    requestFence.invalidate('diff')
    setDiffView(null)
    setDiffFailed(null)
    setLoadingDiff(null)
  }, [currentWorkspace])

  const openDiff = async (filePath: string) => {
    if (!currentWorkspace || loadingDiff) return
    const workspace = currentWorkspace
    const request = requestFence.begin(workspace.id, 'diff')
    setDiffFailed(null)
    setLoadingDiff(filePath)
    try {
      const text = await window.electronAPI.gitFileDiff(workspace.id, filePath)
      if (!requestFence.isCurrent(request)) return
      // '' means the file's changes vanished since the list was built — stay on
      // the list; null means the diff could not be produced at all.
      if (text) setDiffView({ path: filePath, text })
      else if (text === null) setDiffFailed(filePath)
    } catch {
      if (requestFence.isCurrent(request)) setDiffFailed(filePath)
    } finally {
      if (requestFence.isCurrent(request)) setLoadingDiff(null)
    }
  }

  const refreshAll = async () => {
    refresh()
    if (!diffView || !currentWorkspace) return
    const workspace = currentWorkspace
    const path = diffView.path
    const request = requestFence.begin(workspace.id, 'diff')
    setDiffFailed(null)
    setLoadingDiff(path)
    try {
      const text = await window.electronAPI.gitFileDiff(workspace.id, path)
      if (!requestFence.isCurrent(request)) return
      // An empty diff means the change is gone — drop back to the file list
      // instead of rendering a blank diff page.
      if (text) setDiffView({ path, text })
      else setDiffView(null)
    } catch {
      if (requestFence.isCurrent(request)) setDiffFailed(path)
    } finally {
      if (requestFence.isCurrent(request)) setLoadingDiff(null)
    }
  }

  const refreshButton = (
    <button
      onClick={() => void refreshAll()}
      title={t('changes.refresh')}
      className="rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream"
    >
      <RefreshCw size={12} />
    </button>
  )

  let body: React.ReactNode
  if (!currentWorkspace) {
    body = <EmptyState text={t('changes.selectProject')} />
  } else if (info === undefined) {
    body = <EmptyState text={t('panel.loading')} />
  } else if (info === null) {
    body = <EmptyState text={t('changes.notGit')} />
  } else if (diffView) {
    body = (
      <>
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
          <button
            onClick={() => setDiffView(null)}
            title={t('changes.back')}
            className="rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream"
          >
            <ArrowLeft size={12} />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-cream-dim">
            {diffView.path}
          </span>
          {refreshButton}
        </div>
        <div className="flex-1 overflow-auto py-1">
          <div className="min-w-max font-mono text-[11px] leading-[1.7]">
            {diffView.text.split('\n').map((line, i) => (
              <div key={i} className={`whitespace-pre px-2 ${diffLineClass(line)}`}>
                {line === '' ? ' ' : line}
              </div>
            ))}
          </div>
        </div>
      </>
    )
  } else if (info.files.length === 0) {
    body = (
      <>
        <div className="flex h-8 shrink-0 items-center justify-end border-b border-line px-2">
          {refreshButton}
        </div>
        <EmptyState text={t('changes.empty')} />
      </>
    )
  } else {
    body = (
      <>
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="font-mono text-[10px]">
            <span className="text-emerald-500">+{info.totalAdditions}</span>
            <span className="text-cream-faint"> / </span>
            <span className="text-red-500">-{info.totalDeletions}</span>
          </span>
          <span className="flex-1" />
          {refreshButton}
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {diffFailed && (
            <div className="px-3 pb-1 text-[11px] leading-4 text-red-500">
              {t('changes.diffFailed')}
            </div>
          )}
          {info.files.map((file) => (
            <button
              key={file.path}
              onClick={() => void openDiff(file.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-overlay"
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[file.status]}`}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-cream">
                {file.path}
              </span>
              {loadingDiff === file.path ? (
                <Loader2 size={11} className="shrink-0 animate-spin text-cream-faint" />
              ) : (
                <>
                  {file.additions !== null && (
                    <span className="shrink-0 font-mono text-[10px] text-emerald-500">
                      +{file.additions}
                    </span>
                  )}
                  {file.deletions !== null && (
                    <span className="shrink-0 font-mono text-[10px] text-red-500">
                      -{file.deletions}
                    </span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>
      </>
    )
  }

  return <div className="flex min-h-0 flex-1 flex-col">{body}</div>
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
      <FileDiff size={18} className="text-cream-faint" />
      <p className="text-xs leading-5 text-cream-faint">{text}</p>
    </div>
  )
}
