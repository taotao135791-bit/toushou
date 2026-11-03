import { useEffect, useRef, useState } from 'react'
import { Check, Folder, FolderOpen, Loader2, Plus } from 'lucide-react'
import { useProjects } from '../store/projects'
import { useAppStore } from '../store'
import { useT } from '../i18n'

/** Shared by the sidebar + and the composer project selector. */
export default function ProjectPicker({ onDone }: { onDone: () => void }) {
  const t = useT()
  const { projects, loaded, loading, pending, error, refresh, activate, create, importFolder, clearError } = useProjects()
  const current = useAppStore(state => state.currentWorkspace)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const busy = !!pending || loading
  useEffect(() => { if (!loaded) void refresh() }, [loaded, refresh])
  useEffect(() => { if (creating) inputRef.current?.focus() }, [creating])
  useEffect(() => {
    if (!creating && loaded) rootRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
  }, [creating, loaded])
  const submit = async () => {
    if (!name.trim() || busy || composing.current) return
    if (await create(name.trim())) onDone()
  }
  const rowClass = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-cream transition hover:bg-overlay disabled:opacity-40'
  return <div ref={rootRef} aria-label={t('projects.choose')}>
    {creating ? <form onSubmit={event => { event.preventDefault(); void submit() }} className="space-y-2 p-2">
      <label className="block text-xs text-cream-dim" htmlFor="project-name">{t('projects.name')}</label>
      <input ref={inputRef} id="project-name" value={name} onChange={event => setName(event.target.value)} maxLength={60}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return }; if (event.key === 'Escape') { event.stopPropagation(); setCreating(false); clearError() } }}
        className="w-full rounded-lg border border-line bg-ink-850 px-2.5 py-2 text-sm text-cream outline-none focus:border-accent" />
      <p className="text-[11px] leading-5 text-cream-faint">{t('projects.chooseLocation')}</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => { setCreating(false); clearError() }} disabled={busy} className="rounded-lg px-2.5 py-1.5 text-xs text-cream-dim hover:bg-overlay">{t('common.cancel')}</button>
        <button type="submit" disabled={!name.trim() || busy} className="flex items-center gap-1.5 rounded-lg bg-cream px-3 py-1.5 text-xs font-medium text-ink-950 disabled:opacity-40">{pending === 'create' && <Loader2 size={12} className="animate-spin" />}{t('projects.create')}</button>
      </div>
    </form> : <>
      <div className="max-h-64 overflow-y-auto">
        {loading && !loaded && <div role="status" className="px-2.5 py-3 text-xs text-cream-faint">{t('app.loading')}</div>}
        {projects.filter(project => !project.archived).map(project => <button key={project.id} type="button" disabled={busy || project.missing}
          className={rowClass} title={project.isDefault ? t('projects.noProject') : project.path} onClick={async () => { if (await activate(project.id)) onDone() }}>
          {project.isDefault ? <Folder size={14} className="shrink-0 text-cream-faint" /> : <FolderOpen size={14} className="shrink-0 text-cream-faint" />}
          <span className="min-w-0 flex-1"><span className="block truncate">{project.isDefault ? t('projects.noProject') : project.name}</span>{!project.isDefault && <span className="block truncate text-[10.5px] text-cream-faint">{project.missing ? t('projects.missing') : project.path}</span>}</span>
          {current?.realPath === project.path && <Check size={13} className="shrink-0" />}
        </button>)}
      </div>
      <div className="my-1 border-t border-line" />
      <button type="button" className={rowClass} disabled={busy} onClick={() => { clearError(); setCreating(true) }}><Plus size={14} />{t('projects.create')}</button>
      <button type="button" className={rowClass} disabled={busy} onClick={async () => { if (await importFolder()) onDone() }}><FolderOpen size={14} />{t('projects.import')}</button>
    </>}
    {error && <div role="alert" className="px-2.5 py-2 text-xs leading-5 text-red-500">{t(`projects.error.${error}`)}</div>}
  </div>
}
