import { readFile } from 'node:fs/promises'

interface ContextPolicyApi {
  pi: { settings: {
    override?(key: string, value: number | string | boolean): void
    reloadFromDisk?(options: { includeParents: boolean }): Promise<void>
  } }
  on(event: string, apply: () => Promise<void>): void
  registerCommand(name: string, command: {
    description: string
    handler(id: string, ctx: { compact(): Promise<void>; ui: { setStatus(key: string, value: string): void } }): Promise<void>
  }): void
}

/** Runtime overrides are scoped to this OMP child, including resumed sessions. */
export default function contextPolicy(api: ContextPolicyApi): void {
  const file = process.env.TOUSHOU_CONTEXT_POLICY
  if (!file) return
  let applied: number | undefined
  async function apply(): Promise<void> {
    let threshold: number
    try {
      threshold = JSON.parse(await readFile(file!, 'utf8')).compaction.thresholdPercent
    } catch { return }
    if (!Number.isInteger(threshold) || threshold < 50 || threshold > 95 || threshold === applied) return
    const settings = api.pi?.settings
    if (typeof settings?.override === 'function') {
      settings.override('compaction.enabled', true)
      settings.override('compaction.strategy', 'context-full')
      settings.override('compaction.thresholdTokens', -1)
      settings.override('compaction.thresholdPercent', threshold)
    } else if (typeof settings?.reloadFromDisk === 'function') {
      // Newer OMP reads its --config overlay through the parent settings layer.
      // Keep the last good policy if another configuration file is unavailable.
      try { await settings.reloadFromDisk({ includeParents: true }) } catch { return }
    } else return
    applied = threshold
  }
  // Native RPC 'compact' serializes all later commands, including 'abort'.
  // OMP dispatches extension prompts asynchronously, allowing the normal
  // abort RPC to reach the SAME native compactor while the provider is busy.
  api.registerCommand('toushou-compact-context', {
    description: 'Compact this conversation on behalf of the desktop app',
    async handler(id, ctx) {
      if (!/^[0-9a-f-]{36}$/.test(id)) return
      let result = 'ok'
      try { await ctx.compact() }
      catch (err) { result = err instanceof Error ? err.message.slice(0, 350) : 'Compaction failed' }
      ctx.ui.setStatus('toushou-compact:' + id, result)
    }
  })
  api.on('session_start', apply)
  api.on('input', apply)
  api.on('before_agent_start', apply)
  api.on('turn_end', apply)
}
