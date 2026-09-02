import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LoaderCircle, RefreshCw, Wand2 } from 'lucide-react'
import { LaunchableTool } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { launchTool } from '../lib/launchTool'

/** One-click plugin commands for the right-side “使用插件” workspace. */
export default function ToolsPanel() {
  const [tools, setTools] = useState<LaunchableTool[] | null>(null)
  const [error, setError] = useState(false)
  const [launching, setLaunching] = useState<string | null>(null)
  const setWorkspacePanel = useAppStore((s) => s.setWorkspacePanel)
  const t = useT()
  const navigate = useNavigate()

  const load = useCallback(() => {
    setError(false)
    window.electronAPI
      .listLaunchableTools()
      .then(setTools)
      .catch(() => setError(true))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const onLaunch = async (tool: LaunchableTool) => {
    if (launching) return
    setLaunching(tool.id)
    try {
      const id = tool.command ? await launchTool(tool.command) : null
      if (id) {
        navigate('/')
        setWorkspacePanel(null)
      }
    } finally {
      setLaunching(null)
    }
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
        <p className="text-xs text-cream-faint">{t('tools.loadFailed')}</p>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:border-ink-600 hover:text-cream"
        >
          <RefreshCw size={12} />
          {t('tools.retry')}
        </button>
      </div>
    )
  }

  if (tools === null) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-8 text-cream-faint">
        <LoaderCircle size={14} className="animate-spin" />
        <span className="text-xs">{t('tools.loading')}</span>
      </div>
    )
  }

  if (tools.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-xs leading-relaxed text-cream-faint">
        {t('tools.empty')}
      </div>
    )
  }

  const builtIn = tools.filter((tool) => tool.origin === 'bundled')
  const added = tools.filter((tool) => tool.origin === 'installed')

  const renderGroup = (title: string, entries: LaunchableTool[]) => (
    <section className="space-y-2" key={title}>
      <div className="flex items-center gap-2 px-1 text-[11px] font-semibold tracking-wide text-cream-faint">
        <span>{title}</span>
        <span className="rounded-full bg-overlay px-1.5 py-0.5 font-mono text-[10px]">{entries.length}</span>
      </div>
      {entries.map((tool) => (
        <button
          key={tool.id}
          type="button"
          onClick={() => void onLaunch(tool)}
          disabled={launching !== null}
          className="group flex w-full flex-col gap-1 rounded-xl border border-line bg-ink-800/50 px-3 py-2.5 text-left transition-colors hover:border-ink-600 hover:bg-ink-800 disabled:opacity-40"
        >
          <span className="flex items-center gap-2">
            {launching === tool.id ? (
              <LoaderCircle size={13} className="animate-spin text-cream-faint" />
            ) : (
              <Wand2 size={13} className="text-cream-faint" />
            )}
            <span className="min-w-0 truncate text-xs font-medium text-cream">{tool.label}</span>
            <span className="ml-auto shrink-0 rounded bg-ink-850 px-1.5 py-0.5 font-mono text-[10px] text-cream-faint">
              {tool.command}
            </span>
          </span>
          {tool.description && (
            <span className="line-clamp-2 pl-[21px] text-[11px] leading-snug text-cream-faint">
              {tool.description}
            </span>
          )}
        </button>
      ))}
    </section>
  )

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="mb-3 rounded-xl border border-line bg-ink-900/60 px-3 py-2.5 text-[11px] leading-5 text-cream-faint">
        {t('tools.hint')}
      </div>
      <div className="space-y-4">
        {builtIn.length > 0 && renderGroup(t('tools.builtIn'), builtIn)}
        {added.length > 0 && renderGroup(t('tools.added'), added)}
      </div>
    </div>
  )
}
