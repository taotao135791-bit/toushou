import { useRef, useState } from 'react'
import { Check, ChevronUp, Shield } from 'lucide-react'
import { PermissionMode } from '@shared/types'
import { useAppStore } from '../store'
import { I18nKey, useT } from '../i18n'
import MenuPortal from './MenuPortal'

/**
 * Permission-mode pill in the composer toolbar. Every pick persists the
 * default for FUTURE sessions; on top of that, ask/full hot-swap the live
 * session's approval config on the spot (the legacy extension re-reads it per
 * tool call). no-bash/readonly are spawn-time --exclude-tools / --tools — they
 * can only apply to the next session, so they never touch a running one.
 */
/**
 * Anchor color per mode — fixed semantics, not theme tokens, so raw Tailwind
 * palette classes work on both light and dark. Neutral for ask, cool colors
 * for restricted modes, orange for full access so elevated permission reads
 * at a glance (the safety anchor).
 */
const MODES: {
  value: PermissionMode
  labelKey: I18nKey
  descKey: I18nKey
  noteKey?: I18nKey
  /** Shield tint in the trigger chip and the menu row. */
  iconClass: string
  /** Extra label tint in the trigger chip (elevated modes only). */
  labelClass?: string
}[] = [
  { value: 'ask', labelKey: 'settings.permissions.ask', descKey: 'permission.ask.desc', iconClass: 'text-cream-dim' },
  { value: 'full', labelKey: 'settings.permissions.full', descKey: 'permission.full.desc', iconClass: 'text-orange-500', labelClass: 'text-orange-500' },
  // No short plain-language label key exists for no-bash, so its description
  // doubles as the label — the menu never shows the jargon "Bash".
  { value: 'no-bash', labelKey: 'permission.noBash.short', descKey: 'permission.noBash.desc', noteKey: 'composer.permissionNewSession', iconClass: 'text-sky-500' },
  { value: 'readonly', labelKey: 'settings.permissions.readonly', descKey: 'permission.readOnly.desc', noteKey: 'composer.permissionNewSession', iconClass: 'text-emerald-500' }
]

export default function PermissionPicker({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const t = useT()
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  // Feishu-origin sessions are spawned and resumed with a Main-fixed readonly
  // profile; a picker here would either lie or persist a global default the
  // remote session never asked for.
  const remoteLocked = useAppStore(
    (s) => s.sessions.find((x) => x.id === s.currentSessionId)?.origin === 'feishu'
  )
  // The zustand copy keeps the pill in sync with the Settings page.
  const mode = useAppStore((s) => s.permissionMode)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const isCurrent = useAppStore((s) => s.runtimeOverview?.profile === 'current')

  const pick = async (next: PermissionMode) => {
    setOpen(false)
    if (remoteLocked) return
    // Default for future sessions…
    setPermissionMode(next)
    // …plus a hot-swap of the live session's approval config, when possible:
    // legacy profile only (current omp maps modes to spawn-time
    // --tools/--approval-mode) and only ask/full — writing the no-bash/
    // readonly approval config would turn a restricted session into yolo.
    if (currentSessionId && !isCurrent && (next === 'ask' || next === 'full')) {
      await window.electronAPI.updateApprovalConfig(currentSessionId, next)
    }
  }

  const current = MODES.find((m) => m.value === mode)

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => {
          if (!remoteLocked) setOpen((v) => !v)
        }}
        disabled={remoteLocked}
        className="focus-ring flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium whitespace-nowrap text-cream-dim transition-colors hover:bg-overlay hover:text-cream disabled:cursor-not-allowed disabled:opacity-60"
        title={remoteLocked ? t('permission.remoteFixed') : t('composer.permissions')}
        aria-label={t('composer.permissions')}
      >
        <Shield size={12} className={`shrink-0 ${current?.iconClass ?? 'text-cream-dim'}`} />
        {!compact && (
          <span className={current?.labelClass}>{t(current?.labelKey ?? 'settings.permissions.ask')}</span>
        )}
        <ChevronUp size={11} className={`transition ${open ? 'rotate-180' : ''}`} />
      </button>

      <MenuPortal open={open} triggerRef={triggerRef} onClose={() => setOpen(false)} width={232}>
        {MODES.map((m) => (
          <button
            key={m.value}
            onClick={() => pick(m.value)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay"
          >
            <Shield size={12} className={`shrink-0 ${m.iconClass}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{t(m.labelKey)}</span>
              {m.descKey !== m.labelKey && (
                <span className="block truncate text-[10px] text-cream-faint">{t(m.descKey)}</span>
              )}
              {m.noteKey && (
                <span className="block truncate text-[10px] text-cream-faint">{t(m.noteKey)}</span>
              )}
            </span>
            {mode === m.value && <Check size={12} className="shrink-0 text-accent" />}
          </button>
        ))}
      </MenuPortal>
    </div>
  )
}
