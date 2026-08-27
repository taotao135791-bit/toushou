import { useEffect } from 'react'
import { FileText, X, Eye, FileDiff } from 'lucide-react'
import { useAppStore } from '../store'
import { useT, translate } from '../i18n'
import FileTree from './FileTree'
import CodePreview from './CodePreview'
import ChangesPanel from './ChangesPanel'

export default function RightPanel() {
  const {
    activeRightTab,
    currentWorkspace,
    selectedFile,
    previewContent,
    setActiveRightTab,
    setRightPanelOpen,
    setPreviewContent
  } = useAppStore()
  const t = useT()

  useEffect(() => {
    if (!selectedFile || !currentWorkspace || activeRightTab !== 'preview') return
    // Clear the previous file's content up front (loading state), and ignore a
    // late response for a file/workspace the user has already navigated away
    // from — otherwise rapid clicks render file A's content under B's name.
    let cancelled = false
    setPreviewContent(null)
    window.electronAPI.readFile(currentWorkspace.id, selectedFile).then((result) => {
      if (cancelled) return
      setPreviewContent(
        result.ok
          ? result.content
          : translate(useAppStore.getState().language, 'panel.cannotPreview', { error: result.error })
      )
    })
    return () => {
      cancelled = true
    }
  }, [selectedFile, currentWorkspace, activeRightTab, setPreviewContent])

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-ink-900">
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
        </div>
        <button
          onClick={() => setRightPanelOpen(false)}
          className="rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream"
        >
          <X size={14} />
        </button>
      </div>

      <div
        className={
          activeRightTab === 'changes' ? 'flex min-h-0 flex-1 flex-col' : 'flex-1 overflow-y-auto'
        }
      >
        {activeRightTab === 'files' ? (
          <FileTree />
        ) : activeRightTab === 'changes' ? (
          <ChangesPanel />
        ) : (
          <CodePreview filePath={selectedFile} content={previewContent} />
        )}
      </div>
    </aside>
  )
}
