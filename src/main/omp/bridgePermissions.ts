import type { PermissionMode } from '../../shared/types'

const MODES: readonly PermissionMode[] = ['full', 'no-bash', 'readonly', 'ask']

/** Main-only spawn authority. Global changes can narrow but never widen it. */
export class SessionBridgePermissionRegistry {
  private readonly entries = new Map<string, { mode: PermissionMode; locked: boolean; remoteReadonly: boolean }>()

  register(id: string, mode: PermissionMode, remoteReadonly: boolean): void {
    this.entries.set(id, { mode, locked: mode === 'readonly' || mode === 'no-bash' || remoteReadonly, remoteReadonly })
  }

  update(id: string, mode: PermissionMode): void {
    const entry = this.entries.get(id)
    if (entry && !entry.locked && (mode === 'ask' || mode === 'full')) entry.mode = mode
  }

  remove(id: string): void { this.entries.delete(id) }

  get(id: string, globalMode: PermissionMode): { mode: PermissionMode; remoteReadonly: boolean } | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    if (!MODES.includes(entry.mode) || !MODES.includes(globalMode)) return { mode: 'readonly', remoteReadonly: entry.remoteReadonly }
    const mode = entry.mode === 'readonly' || globalMode === 'readonly' ? 'readonly'
      : entry.mode === 'ask' || globalMode === 'ask' ? 'ask'
        : entry.mode === 'no-bash' || globalMode === 'no-bash' ? 'no-bash' : 'full'
    return { mode, remoteReadonly: entry.remoteReadonly }
  }
}
