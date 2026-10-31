import { useT } from '../../i18n'

export interface TTProgress { requestId: string; completed: number; total: number; succeeded: number }

export function TTReadingProgress({ progress, onCancel, cancelling = false }: { progress: TTProgress | null; onCancel: () => void; cancelling?: boolean }) {
  const t = useT()
  return <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-[18px] text-cream-faint">
    <span>{progress ? t('boards.tt.progressCount', { completed: progress.completed, total: progress.total }) : t('boards.tt.progressHint')}</span>
    <button type="button" onClick={onCancel} disabled={cancelling} className="rounded-full border border-line px-2 py-0.5 text-cream-dim hover:text-cream">{t(cancelling ? 'boards.tt.cancelling' : 'boards.tt.cancelReading')}</button>
  </div>
}
