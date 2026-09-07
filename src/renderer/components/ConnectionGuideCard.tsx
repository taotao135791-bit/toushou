import { Plug } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ConnectionGuideKind } from '../lib/connectionMarkers'
import { useT } from '../i18n'

/**
 * 未连接服务的就地引导卡：出现在助手回复下方（非阻塞、不遮内容），
 * 一键直达“连接”页。由回复中的 [[connect:kind]] 标记触发。
 */
export default function ConnectionGuideCard({ kinds }: { kinds: ConnectionGuideKind[] }) {
  const t = useT()
  const navigate = useNavigate()
  if (kinds.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2.5 rounded-xl border border-accent/35 bg-accent/[0.08] px-3 py-2.5">
      <Plug size={14} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 text-[12.5px] leading-5 text-cream-dim">
        {kinds.includes('mcp') ? t('msg.guideMcp') : t('msg.guideFeishu')}
      </span>
      <button
        type="button"
        onClick={() => navigate('/connections')}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-medium text-white shadow-card transition hover:bg-accent-bright"
      >
        {t('msg.guideGo')}
      </button>
    </div>
  )
}
