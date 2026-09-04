import { useEffect } from 'react'
import { FileText, X, Eye, FileDiff, Wand2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { useT, translate } from '../i18n'
import { useGitInfo } from '../lib/useGitInfo'
import FileTree from './FileTree'
import CodePreview from './CodePreview'
import ChangesPanel from './ChangesPanel'
import ToolsPanel from './ToolsPanel'

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

export default function RightPanel() {
  const {
    activeRightTab,
    currentWorkspace,
    selectedFile,
    previewContent,
    setActiveRightTab,
    setRightPanelOpen,
    setPreviewContent
  } = useAppStore(
    useShallow((s) => ({
      activeRightTab: s.activeRightTab,
      currentWorkspace: s.currentWorkspace,
      selectedFile: s.selectedFile,
      previewContent: s.previewContent,
      setActiveRightTab: s.setActiveRightTab,
      setRightPanelOpen: s.setRightPanelOpen,
      setPreviewContent: s.setPreviewContent
    }))
  )
  const t = useT()
  // A non-git workspace has no "changes" to inspect — hide the tab outright
  // instead of showing an empty state. Falls back to files when hidden.
  const { info: gitInfo } = useGitInfo()
  const gitAvailable = Boolean(gitInfo)
  const effectiveTab = activeRightTab === 'changes' && !gitAvailable ? 'files' : activeRightTab

  useEffect(() => {
    if (!selectedFile || !currentWorkspace || activeRightTab !== 'preview') return
    // Clear the previous file's content up front (loading state), and ignore a
    // late response for a file/workspace the user has already navigated away
    // from — otherwise rapid clicks render file A's content under B's name.
    let cancelled = false
    setPreviewContent(null)
    void withTimeout(window.electronAPI.readFile(currentWorkspace.id, selectedFile), FILE_READ_TIMEOUT_MS)
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
            error: error instanceof Error && error.message === 'file-read-timeout'
              ? translate(useAppStore.getState().language, 'panel.timeout')
              : String(error)
          })
        )
      })
    return () => {
      cancelled = true
    }
  }, [selectedFile, currentWorkspace?.id, activeRightTab, setPreviewContent])

  return (
    <aside
      aria-label={t('sidebar.workbench')}
      className="flex w-72 shrink-0 flex-col border-l border-line bg-ink-900"
    >
      <div className="flex h-11 items-center justify-between border-b border-line px-3">
        <div className="flex rounded-full border border-line bg-ink-800 p-0.5">
          <button
            onClick={() => setActiveRightTab('files')}
            className={`flex h-[24px] items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors ${
              activeRightTab === 'files'
                ? 'border-line bg-ink-850 text-cream shadow-card'
                : 'border-transparent text-cream-dim hover:text-cream'
            }`}
          >
            <FileText size={11} />
            {t('panel.files')}
          </button>
          <button
            onClick={() => setActiveRightTab('preview')}
            className={`flex h-[24px] items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors ${
              activeRightTab === 'preview'
                ? 'border-line bg-ink-850 text-cream shadow-card'
                : 'border-transparent text-cream-dim hover:text-cream'
            }`}
          >
            <Eye size={11} />
            {t('panel.preview')}
          </button>
          {gitAvailable && (
            <button
              onClick={() => setActiveRightTab('changes')}
              className={`flex h-[24px] items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors ${
                activeRightTab === 'changes'
                  ? 'border-line bg-ink-850 text-cream shadow-card'
                  : 'border-transparent text-cream-dim hover:text-cream'
              }`}
            >
              <FileDiff size={11} />
              {t('panel.changes')}
            </button>
          )}
          <button
            onClick={() => setActiveRightTab('tools')}
            className={`flex h-[24px] items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors ${
              activeRightTab === 'tools'
                ? 'border-line bg-ink-850 text-cream shadow-card'
                : 'border-transparent text-cream-dim hover:text-cream'
            }`}
          >
            <Wand2 size={11} />
            {t('panel.tools')}
          </button>
        </div>
        <button
          onClick={() => setRightPanelOpen(false)}
          aria-label={t('sidebar.workbench')}
          title={t('sidebar.workbench')}
          className="rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream"
        >
          <X size={14} />
        </button>
      </div>

      <div
        className={
          effectiveTab === 'changes' ? 'flex min-h-0 flex-1 flex-col' : 'flex-1 overflow-y-auto'
        }
      >
        {activeRightTab === 'files' ? (
          <FileTree />
        ) : effectiveTab === 'changes' ? (
          <ChangesPanel />
        ) : effectiveTab === 'tools' ? (
          <ToolsPanel />
        ) : (
          <CodePreview filePath={selectedFile} content={previewContent} />
        )}
      </div>
    </aside>
  )
}
