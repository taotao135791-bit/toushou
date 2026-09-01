import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LoaderCircle, RefreshCw, Wand2 } from 'lucide-react'
import { LaunchableTool } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { launchTool } from '../lib/launchTool'

/**
 * One-click tool list for the right panel. Each entry launches a new chat
 * with the tool's slash command auto-sent — no typing required.
 */
export default function ToolsPanel() {
  const [tools, setTools] = useState<LaunchableTool[] | null>(null)
  const [error, setError] = useState(false)
  const [launching, setLaunching] = useState<string | null>(null)
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen)
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
      const id = await launchTool(tool.command)
      if (id) {
        navigate('/')
        setRightPanelOpen(false)
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

  return (
    <div className="space-y-2 p-3">
      {tools.map((tool) => (
        <button
          key={tool.id}
          type="button"
          onClick={() => void onLaunch(tool)}
          disabled={launching !== null}
          className="group flex w-full flex-col gap-1 rounded-lg border border-line bg-ink-800/50 px-3 py-2.5 text-left transition-colors hover:border-ink-600 disabled:opacity-40"
        >
          <span className="flex items-center gap-2">
            {launching === tool.id ? (
              <LoaderCircle size={13} className="animate-spin text-cream-faint" />
            ) : (
              <Wand2 size={13} className="text-cream-faint" />
            )}
            <span className="text-xs font-medium text-cream">{tool.label}</span>
            <span className="ml-auto rounded bg-ink-850 px-1.5 py-0.5 font-mono text-[10px] text-cream-faint">
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
    </div>
  )
}
