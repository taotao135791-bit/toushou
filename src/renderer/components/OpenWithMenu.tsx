import { useRef, useState } from 'react'
import { Code, ExternalLink, FolderSymlink, Terminal } from 'lucide-react'
import { OpenWorkspaceTarget } from '@shared/types'
import { useT } from '../i18n'
import { showNotice } from '../lib/notice'
import MenuPortal from './MenuPortal'

/**
 * Chat top bar utility menu: open the current workspace folder with an
 * external app (Finder / Terminal / VS Code). Only the workspace grant id
 * travels over IPC — Main resolves the real path itself.
 */
export default function OpenWithMenu({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const openIn = async (target: OpenWorkspaceTarget) => {
    setOpen(false)
    try {
      const result = await window.electronAPI.openWorkspaceIn(workspaceId, target)
      if (!result?.ok) showNotice('chat.openInFailed')
    } catch {
      showNotice('chat.openInFailed')
    }
  }

  const items: Array<{ target: OpenWorkspaceTarget; icon: typeof Code; label: string }> = [
    { target: 'finder', icon: FolderSymlink, label: t('chat.openInFinder') },
    { target: 'terminal', icon: Terminal, label: t('chat.openInTerminal') },
    { target: 'editor', icon: Code, label: t('chat.openInEditor') }
  ]

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        title={t('chat.openIn')}
        aria-label={t('chat.openIn')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="app-no-drag flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-cream-dim transition hover:border-line-strong hover:bg-overlay hover:text-cream"
      >
        <ExternalLink size={13} />
        <span className="hidden text-[12px] font-medium lg:inline">{t('chat.openIn')}</span>
      </button>
      <MenuPortal
        open={open}
        triggerRef={buttonRef}
        onClose={() => setOpen(false)}
        placement="bottom"
        width={196}
      >
        {items.map(({ target, icon: Icon, label }) => (
          <button
            key={target}
            onClick={() => void openIn(target)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay"
          >
            <Icon size={13} className="shrink-0 text-cream-faint" />
            {label}
          </button>
        ))}
      </MenuPortal>
    </div>
  )
}
