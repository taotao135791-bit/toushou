import { useRef, useState } from 'react'
import { Check, ChevronUp, Shield } from 'lucide-react'
import { PermissionMode } from '@shared/types'
import { useAppStore } from '../store'
import { I18nKey, useT } from '../i18n'
import MenuPortal from './MenuPortal'

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
  const [updating, setUpdating] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const t = useT()
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  // Feishu-origin sessions are spawned and resumed with a Main-fixed readonly
  // profile; a picker here would either lie or persist a global default the
  // remote session never asked for.
  const session = useAppStore((s) => s.sessions.find((x) => x.id === s.currentSessionId))
  const remoteLocked = session?.remoteReadonly === true
  const locked = session?.readonly === true || remoteLocked
  // The zustand copy keeps the pill in sync with the Settings page.
  const mode = useAppStore((s) => s.permissionMode)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const canUpdateLive = session?.nativePermissionMutable === true

  const pick = async (next: PermissionMode) => {
    setOpen(false)
    if (locked || updating) return
    // Default for future sessions…
    setPermissionMode(next)
    // …plus a hot-swap of the live session's approval config, when possible:
    // legacy profile only (current omp maps modes to spawn-time
    // --tools/--approval-mode) and only ask/full — writing the no-bash/
    // readonly approval config would turn a restricted session into yolo.
    if (currentSessionId && canUpdateLive && (next === 'ask' || next === 'full')) {
      setUpdating(true)
      try {
        const updated = await window.electronAPI.updateApprovalConfig(currentSessionId, next)
        if (updated) useAppStore.getState().setSessionNativePermission(currentSessionId, next)
      } catch {
        // Keep displaying Main's last confirmed live mode; the new default
        // was saved independently of the live change.
      } finally {
        setUpdating(false)
      }
    }
  }

  const current = MODES.find((m) => m.value === (locked ? 'readonly' : currentSessionId ? session?.nativePermissionMode : mode))
  const defaultMode = MODES.find((m) => m.value === mode)
  const currentLabel = t(current?.labelKey ?? 'composer.permissionUnknown')
  const defaultLabel = t(defaultMode?.labelKey ?? 'composer.permissionUnknown')
  const title = remoteLocked ? t('permission.remoteFixed') : locked ? t('permission.readonlyFixed')
    : currentSessionId ? `${t('composer.permissionSession')} · ${currentLabel}\n${t('composer.permissionDefault')} · ${defaultLabel}` : t('composer.permissions')

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => {
          if (!locked) setOpen((v) => !v)
        }}
        disabled={locked || updating}
        className="composer-picker composer-permission-picker focus-ring flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium whitespace-nowrap text-cream-dim transition-colors hover:bg-overlay hover:text-cream disabled:cursor-not-allowed disabled:opacity-60"
        title={title}
        aria-label={t('composer.permissions')}
        aria-description={currentSessionId ? title : undefined}
      >
        <Shield size={12} className={`shrink-0 ${current?.iconClass ?? 'text-cream-dim'}`} />
        {!compact && (
          <span className={current?.labelClass}>{currentLabel}</span>
        )}
        {!compact && <ChevronUp size={11} className={`composer-picker-chevron transition ${open ? 'rotate-180' : ''}`} />}
      </button>

      <MenuPortal open={open} triggerRef={triggerRef} onClose={() => setOpen(false)} width={232}>
        {currentSessionId && <div className="border-b border-line px-2.5 py-1.5 text-[11px] text-cream-dim">
          {t('composer.permissionSession')} · {currentLabel}
        </div>}
        <div className="px-2.5 py-1 text-[11px] text-cream-dim">{t('composer.permissionDefault')}</div>
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
              {(m.noteKey || (currentSessionId && canUpdateLive)) && (
                <span className="block truncate text-[10px] text-cream-faint">{t(m.noteKey ?? 'composer.permissionAlsoLive')}</span>
              )}
            </span>
            {mode === m.value && <Check size={12} className="shrink-0 text-accent" />}
          </button>
        ))}
      </MenuPortal>
    </div>
  )
}
