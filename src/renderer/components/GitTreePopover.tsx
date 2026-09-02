import { useEffect, useState } from 'react'
import { FileCode2, FileDiff } from 'lucide-react'
import { useAppStore } from '../store'
import { useT, translate } from '../i18n'
import FileTree from './FileTree'
import CodePreview from './CodePreview'
import ChangesPanel from './ChangesPanel'

const FILE_READ_TIMEOUT_MS = 8_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('file-read-timeout')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Git-owned code surface. It lives below the branch chip, never in the task workspace. */
export default function GitTreePopover() {
  const t = useT()
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const selectedFile = useAppStore((s) => s.selectedFile)
  const [view, setView] = useState<'code' | 'changes'>('code')
  const [previewContent, setPreviewContent] = useState<string | null>(null)

  useEffect(() => {
    if (!currentWorkspace || !selectedFile || view !== 'code') {
      setPreviewContent(null)
      return
    }
    let cancelled = false
    setPreviewContent(null)
    void withTimeout(
      window.electronAPI.readFile(currentWorkspace.id, selectedFile),
      FILE_READ_TIMEOUT_MS
    )
      .then((result) => {
        if (cancelled) return
        setPreviewContent(
          result.ok
            ? result.content
            : translate(useAppStore.getState().language, 'panel.cannotPreview', { error: result.error })
        )
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setPreviewContent(
          translate(useAppStore.getState().language, 'panel.readFailed', {
            error:
              error instanceof Error && error.message === 'file-read-timeout'
                ? translate(useAppStore.getState().language, 'panel.timeout')
                : String(error)
          })
        )
      })
    return () => {
      cancelled = true
    }
  }, [currentWorkspace?.id, selectedFile, view])

  return (
    <div className="absolute left-0 top-9 z-30 flex h-[min(70vh,520px)] w-[min(760px,72vw)] min-w-[560px] overflow-hidden rounded-xl border border-line bg-ink-950 shadow-2xl">
      <div className="flex w-[42%] min-w-[230px] flex-col border-r border-line">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
          <button
            type="button"
            onClick={() => setView('code')}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${view === 'code' ? 'bg-overlay text-cream' : 'text-cream-faint hover:text-cream'}`}
          >
            <FileCode2 size={12} />
            {t('git.code')}
          </button>
          <button
            type="button"
            onClick={() => setView('changes')}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${view === 'changes' ? 'bg-overlay text-cream' : 'text-cream-faint hover:text-cream'}`}
          >
            <FileDiff size={12} />
            {t('git.changes')}
          </button>
        </div>
        {view === 'code' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FileTree />
          </div>
        ) : (
          <ChangesPanel />
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        {view === 'code' ? (
          <CodePreview filePath={selectedFile} content={previewContent} />
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-xs text-cream-faint">
            {currentWorkspace ? t('git.selectChange') : t('changes.selectProject')}
          </div>
        )}
      </div>
      {!currentWorkspace && view === 'code' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink-950/80 text-xs text-cream-faint">
          {t('panel.selectProject')}
        </div>
      )}
    </div>
  )
}
