import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Copy, FolderOpen, Loader2, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import type { ProjectRecord } from '@shared/types'
import { useProjects } from '../store/projects'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import MenuPortal from './MenuPortal'
import ProjectPicker from './ProjectPicker'
import { currentNavigationIntent } from '../lib/navigationIntent'

function ProjectRow({ project, conversations }: { project: ProjectRecord; conversations?: ReactNode }) {
  const t = useT()
  const { activate, archive, restore, remove, pending } = useProjects()
  const current = useAppStore(state => state.currentWorkspace)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const isCurrent = current?.realPath === project.path
  return <div data-project-id={project.id}>
    <div className={`group flex items-center rounded-lg ${isCurrent ? 'bg-overlay' : 'hover:bg-overlay'}`}>
    {!project.archived && <button type="button" aria-label={t('projects.conversations', { name: project.name })} aria-expanded={expanded} aria-controls={`project-conversations-${project.id}`}
      onClick={() => setExpanded(value => !value)} className="ml-1 shrink-0 rounded p-1 text-cream-faint hover:bg-overlay focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>}
    <button type="button" disabled={!!pending || project.archived || project.missing} title={project.path}
      onClick={() => { setExpanded(true); if (!isCurrent) void activate(project.id) }} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left disabled:opacity-60">
      <FolderOpen size={14} className="shrink-0 text-cream-faint" />
      <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] text-cream">{project.isDefault ? t('sidebar.defaultWorkspace') : project.name}</span><span className="block truncate text-[10.5px] text-cream-faint">{project.missing ? t('projects.missing') : project.path}</span></span>
    </button>
    {pending?.endsWith(project.id) && <Loader2 size={12} className="shrink-0 animate-spin text-cream-faint" />}
    <button ref={trigger} type="button" aria-label={t('projects.actions', { name: project.name })} aria-expanded={open} aria-haspopup="menu"
      onClick={() => setOpen(value => !value)} className="mr-1 rounded-md p-1.5 text-cream-faint hover:bg-overlay-strong hover:text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><MoreHorizontal size={14} /></button>
    <MenuPortal open={open} triggerRef={trigger} onClose={() => { setOpen(false); setCopied(false); setCopyFailed(false) }} width={256} placement="bottom">
      <div className="px-2.5 py-2"><div className="truncate text-xs font-medium text-cream">{project.name}</div><div className="mt-1 break-all text-[11px] leading-4 text-cream-faint">{project.path}</div></div>
      <button type="button" className="project-menu-action" onClick={async () => { try { await navigator.clipboard.writeText(project.path); setCopied(true) } catch { setCopyFailed(true) } }}><Copy size={13} />{copied ? t('projects.copied') : t('projects.copyPath')}</button>
      {copyFailed && <p role="alert" className="px-2.5 py-1 text-xs text-red-500">{t('projects.copyFailed')}</p>}
      {project.isDefault ? <p className="px-2.5 py-2 text-[11px] leading-5 text-cream-faint">{t('projects.defaultHelp')}</p> : <>
        <div className="my-1 border-t border-line" />
        <button type="button" disabled={!!pending} className="project-menu-action" onClick={async () => { setOpen(false); await (project.archived ? restore(project.id) : archive(project.id)) }}>{project.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}{t(project.archived ? 'projects.restore' : 'projects.archive')}</button>
        <button type="button" disabled={!!pending} className="project-menu-action text-red-500" onClick={() => { setOpen(false); void remove(project.id) }}><Trash2 size={13} />{t('projects.delete')}</button>
      </>}
    </MenuPortal>
    </div>
    {!project.archived && expanded && <div id={`project-conversations-${project.id}`} className="ml-3 border-l border-line pl-1" data-project-conversations={project.id}>
      {conversations || <p className="px-2.5 py-2 text-[11.5px] text-cream-faint">{t('projects.noConversations')}</p>}
    </div>}
  </div>
}

export default function SidebarProjects({ renderConversations }: { renderConversations?: (path: string) => ReactNode } = {}) {
  const t = useT()
  const { projects, loaded, loading, error, refresh, activate, pending, clearError } = useProjects()
  const [expanded, setExpanded] = useState(true)
  const [archived, setArchived] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const plusRef = useRef<HTMLButtonElement>(null)
  const optionsRef = useRef<HTMLButtonElement>(null)
  const booted = useRef(false)
  useEffect(() => { if (!loaded) void refresh() }, [loaded, refresh])
  useEffect(() => {
    if (!loaded || booted.current) return
    booted.current = true
    if (!useAppStore.getState().currentWorkspace) {
      const fallback = projects.find(project => project.isDefault)
      if (fallback) void activate(fallback.id, currentNavigationIntent())
    }
  }, [loaded, projects, activate])
  useEffect(() => {
    const reload = () => void refresh()
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [refresh])
  const visible = projects.filter(project => !project.isDefault && project.archived === archived)
  return <section className="mt-5 flex min-h-0 flex-col px-2.5" aria-label={t('sidebar.project')}>
    <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs font-semibold text-cream-faint" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t(archived ? 'projects.archived' : 'sidebar.project')}<ChevronDown size={12} className={expanded ? '' : '-rotate-90'} /></button>
      <button ref={optionsRef} type="button" className="rounded-md p-1 text-cream-faint hover:bg-overlay hover:text-cream" aria-label={t('projects.options')} aria-expanded={optionsOpen} onClick={() => setOptionsOpen(value => !value)}><MoreHorizontal size={15} /></button>
      <button ref={plusRef} type="button" className="rounded-md p-1 text-cream-faint hover:bg-overlay hover:text-cream" aria-label={t('projects.create')} aria-expanded={createOpen} onClick={() => { clearError(); setCreateOpen(value => !value) }}><Plus size={15} /></button>
    </div>
    <MenuPortal open={optionsOpen} triggerRef={optionsRef} onClose={() => setOptionsOpen(false)} width={200} placement="bottom"><button type="button" className="project-menu-action" onClick={() => { setArchived(value => !value); setExpanded(true); setOptionsOpen(false) }}><Archive size={13} />{t(archived ? 'projects.active' : 'projects.archived')}</button></MenuPortal>
    <MenuPortal open={createOpen} triggerRef={plusRef} onClose={() => setCreateOpen(false)} width={300} placement="bottom"><ProjectPicker onDone={() => { setCreateOpen(false); setArchived(false); setExpanded(true); plusRef.current?.focus() }} /></MenuPortal>
    {expanded && <div className="min-h-0 max-h-56 space-y-0.5 overflow-y-auto overscroll-contain" data-project-list>
      {loading && !loaded && <p role="status" className="px-2 py-3 text-xs text-cream-faint">{t('app.loading')}</p>}
      {visible.map(project => <ProjectRow key={project.id} project={project} conversations={renderConversations?.(project.path)} />)}
      {loaded && !visible.length && <p className="px-2 py-3 text-xs text-cream-faint">{t(archived ? 'projects.noArchived' : 'projects.empty')}</p>}
    </div>}
    {error && !createOpen && <div role="alert" className="px-2 py-2 text-xs leading-5 text-red-500">{t(`projects.error.${error}`)}<button type="button" disabled={!!pending} onClick={() => void refresh()} className="ml-2 underline">{t('projects.retry')}</button></div>}
  </section>
}
