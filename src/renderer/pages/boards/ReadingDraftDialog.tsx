import { useId, useRef } from 'react'
import { useModalBoundary } from '../../lib/modalBoundary'

export interface LocalCampaignMapping { label: string; name: string }
export interface ReadingDraftDialogProps {
  title: string
  language: 'zh' | 'en'
  value: string
  copyState: 'copied' | 'failed' | null
  localMappings?: LocalCampaignMapping[]
  onChange: (value: string) => void
  onClose: () => void
  onCopy: () => void
}

/** Actual campaign names remain outside the copied, user-editable draft. */
export function ReadingDraftDialog({ title, language, value, copyState, localMappings = [], onChange, onClose, onCopy }: ReadingDraftDialogProps) {
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  useModalBoundary(root, true, onClose)
  const zh = language === 'zh'
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-instructions`} tabIndex={-1} className="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-line bg-ink-850 p-5 shadow-card">
      <h2 id={`${id}-title`} className="text-[16px] font-semibold text-cream">{title}</h2>
      <p id={`${id}-instructions`} className="mt-1 text-[12px] text-cream-faint">{zh ? '可先修改草稿，再复制并粘贴到聊天中。' : 'Edit the draft, copy it, then paste it into a chat when ready.'}</p>
      <textarea autoFocus aria-label={title} value={value} onChange={event => onChange(event.target.value)} className="mt-3 min-h-48 w-full rounded-lg border border-line bg-ink-900 p-3 text-[13px] text-cream" />
      {localMappings.length > 0 && <section aria-label={zh ? '账户和活动对应关系' : 'Account and campaign mapping'} className="mt-3 rounded-lg border border-line p-3 text-[12px] text-cream-dim">
        <p className="font-medium text-cream">{zh ? '账户和活动对应关系（仅本地显示，不会复制或发送）' : 'Account and campaign mapping (shown locally; not copied or sent)'}</p>
        <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto">{localMappings.map((item, index) => <li key={`${item.label}-${index}`} className="break-words">{item.label}：{item.name}</li>)}</ul>
      </section>}
      {copyState && <p role="status" className="mt-2 text-[12px] text-cream-dim">{copyState === 'copied' ? (zh ? '已复制，可粘贴到聊天中继续。' : 'Copied. Paste it into a chat to continue.') : (zh ? '复制失败，请手动选择并复制文字。' : 'Could not copy. Select and copy the text manually.')}</p>}
      <div className="mt-3 flex justify-end gap-2"><button type="button" onClick={onClose} className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim">{zh ? '关闭' : 'Close'}</button><button type="button" onClick={onCopy} className="focus-ring rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-[rgb(var(--bg-app))]">{zh ? '复制草稿' : 'Copy draft'}</button></div>
    </div>
  </div>
}
