import { powerMonitor } from 'electron'

/**
 * Token keep-alive — one Main-process timer that keeps the OAuth access
 * tokens of the MCP integrations (TikTok Ads, AppsFlyer) renewed in the
 * background, BEFORE they expire.
 *
 * Why: both connectors previously renewed lazily (on first read after
 * expiry) and a single transient failure at that moment degraded the
 * connection to "请重新授权" — which read to users as "授权总是掉". The
 * keep-alive renews inside each manager's proactive margin while the token
 * is still valid, and the managers themselves retry transient failures on a
 * bounded cadence.
 *
 * Boundaries: same-route renewal only (whatever proxy the session already
 * uses). This never switches network routes/nodes and never opens a browser;
 * when renewal is impossible the connection stays degraded with its honest
 * error and only the user can re-authorize.
 */

export type KeepAliveTarget = () => Promise<boolean>

const TICK_MS = 5 * 60 * 1000
/** First tick shortly after start: renew anything that aged while closed. */
const FIRST_TICK_MS = 30 * 1000

class TokenKeepAlive {
  private readonly targets = new Map<string, KeepAliveTarget>()
  private timer: ReturnType<typeof setInterval> | null = null
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private ticking = false

  registerTarget(name: string, target: KeepAliveTarget): void {
    this.targets.set(name, target)
  }

  isRunning(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null
      void this.tick()
    }, FIRST_TICK_MS)
    // Tokens age past their margin while the machine sleeps; renew once the
    // network stack is back rather than waiting for the next interval edge.
    try {
      powerMonitor.on('resume', this.onSystemResume)
    } catch { /* powerMonitor unavailable in tests — the interval still runs */ }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.firstTimer) { clearTimeout(this.firstTimer); this.firstTimer = null }
    try {
      powerMonitor.removeListener('resume', this.onSystemResume)
    } catch { /* not attached */ }
  }

  private readonly onSystemResume = (): void => {
    // Give the network a moment to settle after wake before renewing.
    setTimeout(() => { if (this.timer) void this.tick() }, 5_000)
  }

  /** One pass over every registered target; a failure of one never blocks the rest. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const [name, target] of this.targets) {
        try {
          await target()
        } catch (error) {
          // Keep-alive is best-effort: the manager keeps its own degraded
          // state and honest error; we just never let a tick crash Main.
          console.error(`[token-keepalive] ${name} renewal failed:`, error)
        }
      }
    } finally {
      this.ticking = false
    }
  }
}

/** App-wide instance; wired with both MCP managers in index.ts. */
export const tokenKeepAlive = new TokenKeepAlive()
