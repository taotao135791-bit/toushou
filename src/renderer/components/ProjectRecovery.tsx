import { FolderOpen, Loader2 } from 'lucide-react'
import type { ProjectRecord } from '@shared/types'
import { useProjects } from '../store/projects'
import { useT } from '../i18n'

/** Recovery stays attached to its project; the native picker verifies its original path. */
export default function ProjectRecovery({ project, onRecovered }: { project: ProjectRecord; onRecovered?: () => void }) {
  const t = useT()
  const { error, errorProjectId, pending, recover } = useProjects()
  const projectError = errorProjectId === project.id ? error : null
  if ((!project.missing || project.archived) && !projectError) return null
  return <div className="space-y-1.5 px-2.5 pb-2 text-[11px] leading-4" data-project-recovery={project.id}>
    {project.missing && !project.archived && <>
      <p className="text-cream-dim">{t(`projects.unavailable.${project.unavailableReason ?? 'missing'}`)}</p>
      <button type="button" disabled={!!pending} className="focus-ring flex items-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-cream transition hover:bg-overlay disabled:opacity-40"
        onClick={async () => { if (await recover(project.id)) onRecovered?.() }}>
        {pending === `recover:${project.id}` ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
        {t('projects.reconnect')}
      </button>
    </>}
    {projectError && <p role="alert" className="text-red-500">{t(`projects.error.${projectError}`)}</p>}
  </div>
}
