import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { showNotice } from '../lib/notice'

/**
 * 「已记住」toast：模型写入一条长期记忆后弹出，带撤销按钮（点击即删）。
 * 自动 8 秒消失；重复保存（模型重复记忆同一句话）不弹。
 */
const VISIBLE_MS = 8_000

interface PendingMemory {
  id: string
  scope: 'global' | 'project'
  text: string
  cwd?: string
  expiresAt: number
}

export default function MemorySavedToast() {
  const t = useT()
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const [pending, setPending] = useState<PendingMemory | null>(null)

  useEffect(() => {
    if (typeof window.electronAPI.onMemorySaved !== 'function') return
    return window.electronAPI.onMemorySaved((event) => {
      if (event.duplicate) return
      setPending({ ...event, expiresAt: Date.now() + VISIBLE_MS })
    })
  }, [])

  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setPending(null), Math.max(0, pending.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [pending])

  const undo = async () => {
    if (!pending) return
    const { id, scope, cwd } = pending
    setPending(null)
    // 优先用写入来源会话的项目层（查看方可能已切到别的项目）。
    const done = await window.electronAPI.memoryDelete(scope, id, cwd ?? currentWorkspace?.realPath)
    if (!done) showNotice('settings.memory.deleteFailed')
  }

  if (!pending) return null
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-ink-850 py-1.5 pl-3 pr-1.5 shadow-pop"
    >
      <Check size={13} className="shrink-0 text-accent" />
      <span className="max-w-[360px] truncate text-xs text-cream" title={pending.text}>
        {t(pending.scope === 'global' ? 'settings.memory.savedGlobal' : 'settings.memory.savedProject', { text: pending.text })}
      </span>
      <button
        onClick={() => void undo()}
        className="focus-ring shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-overlay"
      >
        {t('settings.memory.undo')}
      </button>
      <button
        onClick={() => setPending(null)}
        aria-label={t('common.cancel')}
        className="focus-ring shrink-0 rounded-full p-1 text-cream-faint hover:bg-overlay hover:text-cream"
      >
        <X size={11} />
      </button>
    </div>
  )
}
