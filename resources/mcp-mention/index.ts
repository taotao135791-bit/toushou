/** Reconnect only the native MCP servers explicitly chosen for an idle prompt. */
interface MentionExtensionApi {
  on(event: 'before_agent_start', handler: (event: { prompt: string }) => Promise<void>): void
}

export default function mcpMention(api: MentionExtensionApi): void {
  api.on('before_agent_start', async ({ prompt }) => {
    const selection = /^Explicitly selected MCP connections for this turn: ([^\n]+)\.\n\n/.exec(prompt)?.[1]
    if (!selection) return
    const names = selection.split(', ').filter(name => /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(name))
    if (!names.length) return

    try {
      // OMP bundles this public subpath for extensions. Leave older runtimes
      // usable when they cannot expose their process-global MCP manager.
      const { MCPManager } = await import('@oh-my-pi/pi-coding-agent/mcp')
      const manager = MCPManager?.instance?.()
      if (!manager) return

      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.allSettled(names.map(async name => {
            if (!manager.getServerConfig(name)) return
            if (manager.getConnectionStatus(name) === 'connecting') {
              return manager.waitForConnection(name).catch(() => manager.reconnectServer(name, { manual: true }))
            }
            return manager.reconnectServer(name, { manual: true })
          })),
          new Promise<void>(resolve => { timeout = setTimeout(resolve, 1800) })
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    } catch { /* The turn still contains the explicit tool request. */ }
  })
}
