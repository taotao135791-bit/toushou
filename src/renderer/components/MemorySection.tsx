import { useCallback, useEffect, useState } from 'react'
import { ArrowUpDown, Lock, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { MemoryEntry, MemoryScope } from '@shared/memory'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { showNotice } from '../lib/notice'

/**
 * 长期记忆管理区（设置页）：全局记忆与当前项目的记忆分列展示，支持
 * 手动添加、编辑、删除和跨层移动（提升为全局/移入本项目）。跨层移动是
 * 项目间共享的唯一通道——没有自动机制。
 */
export default function MemorySection() {
  const t = useT()
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const cwd = currentWorkspace?.realPath ?? null
  const [globalEntries, setGlobalEntries] = useState<MemoryEntry[] | null>(null)
  const [projectEntries, setProjectEntries] = useState<MemoryEntry[] | null>(null)
  const [draft, setDraft] = useState('')
  const [draftScope, setDraftScope] = useState<MemoryScope>('project')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const refresh = useCallback(() => {
    void window.electronAPI.memoryList(cwd).then((layers) => {
      setGlobalEntries(layers.global)
      setProjectEntries(layers.project)
    }).catch(() => {
      setGlobalEntries([])
      setProjectEntries([])
    })
  }, [cwd])

  useEffect(() => {
    refresh()
  }, [refresh])

  const add = async () => {
    const text = draft.trim()
    if (!text) return
    const result = await window.electronAPI.memorySave({
      text,
      scope: draftScope,
      ...(draftScope === 'project' && cwd ? { cwd } : {})
    })
    if (result.ok) {
      setDraft('')
      refresh()
    } else {
      showNotice('settings.memory.addFailed')
    }
  }

  const remove = async (scope: MemoryScope, id: string) => {
    const done = await window.electronAPI.memoryDelete(scope, id, cwd ?? undefined)
    if (!done) showNotice('settings.memory.deleteFailed')
    refresh()
  }

  const saveEdit = async (scope: MemoryScope, id: string) => {
    if (!editText.trim()) return
    const done = await window.electronAPI.memoryUpdate(scope, id, editText.trim(), cwd ?? undefined)
    setEditingId(null)
    setEditText('')
    if (!done) showNotice('settings.memory.updateFailed')
    refresh()
  }

  const move = async (id: string, from: MemoryScope) => {
    const to: MemoryScope = from === 'global' ? 'project' : 'global'
    if (to === 'project' && !cwd) return
    const done = await window.electronAPI.memoryMove(id, from, to, cwd ?? undefined)
    if (!done) showNotice('settings.memory.moveFailed')
    refresh()
  }

  const listBlock = (scope: MemoryScope, entries: MemoryEntry[] | null, title: string, locked: boolean) => (
    <div className="rounded-xl border border-line p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        {locked && <Lock size={12} className="text-cream-faint" />}
        <h4 className="text-[12px] font-medium text-cream">{title}</h4>
        <span className="text-[11px] text-cream-faint">{entries?.length ?? '…'}</span>
      </div>
      {entries !== null && entries.length === 0 && (
        <p className="px-1 py-1 text-[11.5px] text-cream-faint">{t('settings.memory.empty')}</p>
      )}
      <div className="space-y-1">
        {(entries ?? []).map((entry) => (
          <div key={entry.id} className="group flex items-start gap-1.5 rounded-lg px-1.5 py-1 hover:bg-overlay">
            {editingId === entry.id ? (
              <>
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={2}
                  className="min-w-0 flex-1 resize-none rounded-md border border-line bg-ink-900 px-2 py-1 text-[12px] text-cream outline-none focus:border-accent/40"
                />
                <button
                  onClick={() => void saveEdit(scope, entry.id)}
                  title={t('settings.memory.saveEdit')}
                  aria-label={t('settings.memory.saveEdit')}
                  className="focus-ring mt-0.5 rounded-md p-1 text-accent hover:bg-overlay-strong"
                >
                  ✓
                </button>
                <button
                  onClick={() => { setEditingId(null); setEditText('') }}
                  title={t('common.cancel')}
                  aria-label={t('common.cancel')}
                  className="focus-ring mt-0.5 rounded-md p-1 text-cream-faint hover:bg-overlay-strong"
                >
                  <X size={12} />
                </button>
              </>
            ) : (
              <>
                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-cream-dim">{entry.text}</p>
                <span className="mt-0.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={() => { setEditingId(entry.id); setEditText(entry.text) }}
                    title={t('settings.memory.edit')}
                    aria-label={t('settings.memory.edit')}
                    className="focus-ring rounded-md p-1 text-cream-faint hover:bg-overlay-strong hover:text-cream"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    onClick={() => void move(entry.id, scope)}
                    disabled={locked && scope === 'project'}
                    title={scope === 'global' ? t('settings.memory.moveToProject') : t('settings.memory.moveToGlobal')}
                    aria-label={scope === 'global' ? t('settings.memory.moveToProject') : t('settings.memory.moveToGlobal')}
                    className="focus-ring rounded-md p-1 text-cream-faint hover:bg-overlay-strong hover:text-cream disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowUpDown size={11} />
                  </button>
                  <button
                    onClick={() => void remove(scope, entry.id)}
                    title={t('settings.memory.delete')}
                    aria-label={t('settings.memory.delete')}
                    className="focus-ring rounded-md p-1 text-cream-faint hover:bg-red-500/15 hover:text-red-500"
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
                {entry.source?.sessionTitle && (
                  <span
                    className="mt-0.5 max-w-[90px] shrink-0 truncate text-[10px] text-cream-faint/70"
                    title={t('settings.memory.from', { title: entry.source.sessionTitle })}
                  >
                    {entry.source.sessionTitle}
                  </span>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div role="group" aria-labelledby="settings-memory-heading" className="py-2.5">
      <h3 id="settings-memory-heading" className="mb-1 text-[13px] font-medium text-cream">{t('settings.memory.title')}</h3>
      <p className="mb-2 text-[11.5px] leading-4 text-cream-faint">{t('settings.memory.hint')}</p>
      <div className="mb-2.5 flex items-center gap-1.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder={t('settings.memory.placeholder')}
          className="min-w-0 flex-1 resize-none rounded-lg border border-line bg-ink-900 px-2.5 py-1.5 text-[12px] text-cream placeholder-cream-faint outline-none focus:border-accent/40"
        />
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex rounded-full border border-line p-0.5">
            {(['project', 'global'] as MemoryScope[]).map((scope) => (
              <button
                key={scope}
                onClick={() => setDraftScope(scope)}
                className={`focus-ring rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  draftScope === scope ? 'bg-ink-850 text-cream' : 'text-cream-faint hover:text-cream-dim'
                }`}
              >
                {t(scope === 'project' ? 'settings.memory.scopeProject' : 'settings.memory.scopeGlobal')}
              </button>
            ))}
          </div>
          <button
            onClick={() => void add()}
            disabled={!draft.trim()}
            title={t('settings.memory.add')}
            aria-label={t('settings.memory.add')}
            className="focus-ring flex h-7 items-center gap-1 rounded-full bg-accent px-2.5 text-[11px] font-medium text-[rgb(var(--bg-app))] transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:bg-overlay-strong disabled:text-cream-faint"
          >
            <Plus size={12} />
            {t('settings.memory.add')}
          </button>
        </div>
      </div>
      <div className="space-y-2">
        {listBlock('global', globalEntries, t('settings.memory.globalTitle'), false)}
        {listBlock('project', projectEntries, t('settings.memory.projectTitle'), !cwd)}
      </div>
    </div>
  )
}
