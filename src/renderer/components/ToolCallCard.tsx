import { memo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type { ToolCallRecord } from '../lib/toolCalls'
import { presentToolCall } from '../lib/toolPresentation'
import { toolBrandForCall, websiteSourceForCall } from '../lib/toolBrand'
import { useAppStore } from '../store'
import { getToolRenderer } from './tools'
import GenericToolContent from './tools/generic'
import BrandIcon from './BrandIcon'
import WebsiteIcon from './WebsiteIcon'

interface ToolCallCardProps { toolCall: ToolCallRecord }

function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const language = useAppStore(state => state.language)
  const [expanded, setExpanded] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  const presentation = presentToolCall(toolCall, language)
  const brand = toolBrandForCall(toolCall)
  const website = websiteSourceForCall(toolCall)
  const Content = getToolRenderer(toolCall.tool)

  // Internal metadata has no document or account action to inspect.
  if (toolCall.tool === 'toushou_session_topic') {
    return <div className="flex min-h-8 items-center gap-2.5 px-3 text-xs text-cream-faint">
      {presentation.status === 'running' && <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{presentation.label}</span>
      <span className="shrink-0">{presentation.statusLabel}</span>
    </div>
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="focus-ring flex min-h-9 w-full min-w-0 items-center gap-2 px-3 text-left transition-colors hover:bg-overlay"
      >
        {presentation.status === 'running' ? <Loader2 size={12} className="shrink-0 animate-spin text-cream-faint" aria-hidden="true" /> :
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${presentation.status === 'failed' ? 'bg-red-500' : presentation.status === 'completed' ? 'bg-emerald-500' : 'bg-cream-faint'}`} />}
        {website ? <WebsiteIcon url={website.url} hostname={website.hostname} size={16} /> : <BrandIcon brand={brand} size={16} />}
        <span className="min-w-0 truncate text-[13px] font-medium text-cream">{presentation.label}</span>
        {(website || presentation.summary) && <span className="min-w-0 flex-1 truncate text-[12px] text-cream-faint">{website?.hostname ?? presentation.summary}</span>}
        <span className="ml-auto shrink-0 whitespace-nowrap text-[12px] text-cream-faint">{presentation.statusLabel}</span>
        {expanded ? <ChevronDown size={13} className="shrink-0 text-cream-faint" aria-hidden="true" /> : <ChevronRight size={13} className="shrink-0 text-cream-faint" aria-hidden="true" />}
      </button>
      {expanded && (
        <div className="fade-in mb-2.5 ml-[14px] mr-3 min-w-0 border-l-2 border-line py-0.5 pl-3">
          <Content toolCall={toolCall} />
          <details className="mt-2" open={rawOpen} onToggle={(event) => setRawOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-[12px] text-cream-faint">{language === 'zh' ? '原始工具详情' : 'Original tool details'}</summary>
            {rawOpen && <div className="mt-2 min-w-0 space-y-2"><p className="break-all font-mono text-[12px] text-cream-dim">{toolCall.tool}</p><GenericToolContent toolCall={toolCall} /></div>}
          </details>
        </div>
      )}
    </div>
  )
}

export default memo(ToolCallCard)
