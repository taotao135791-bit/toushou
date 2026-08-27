import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { CliInfo, ExtensionUiAnswer, SessionEvent } from '../../../shared/types'
import { executableSearchDirs } from '../OmpCapabilities'
import { EnvMode, resolveSubprocessEnv } from '../env'
import { OmpSession, OmpProcessLike } from '../OmpSession'

/**
 * Short-lived RPC client for runtime queries and interactive flows
 * (login). Unlike chat sessions these are headless: spawn, query, kill.
 *
 * Zero-auth bootstrap: current Oh My Pi refuses to start RPC mode without
 * at least one configured model (verified 17.2.12), so on a machine with no
 * credentials at all the client can be spawned with a placeholder env key
 * for a provider whose model catalog is static (deepseek, verified). That
 * brings the login surface up honestly — the caller must then treat that
 * provider's reported `authenticated` as placeholder, not real auth.
 */

export const BOOTSTRAP_PROVIDER_ID = 'deepseek'
export const BOOTSTRAP_ENV_KEY = 'DEEPSEEK_API_KEY'
export const BOOTSTRAP_ENV_VALUE = 'omp-gui-bootstrap-placeholder'

export interface RpcClientOptions {
  /** Extra CLI args (e.g. --no-extensions to keep probes quiet). */
  args?: string[]
  /** Extra environment overrides. */
  env?: NodeJS.ProcessEnv
  /** `inherit` (default) or `replace` — see resolveSubprocessEnv. */
  envMode?: EnvMode
  /** Where the process runs (config/session state is HOME-scoped anyway). */
  cwd?: string
}

export interface RpcClientEvents {
  onEvent?: (event: SessionEvent) => void
  onOpenUrl?: (url: string, launchUrl?: string, instructions?: string) => void
  /** Fires when the process dies unexpectedly (not via kill()). */
  onExit?: (code: number | null, stderrTail: string) => void
}

export class RuntimeRpcClient {
  private constructor(private readonly session: OmpSession) {}

  /**
   * Spawn and verify the runtime answers a get_state probe.
   * Resolves null when the process is unusable (won't start / no models).
   */
  static async spawn(
    cli: CliInfo,
    opts: RpcClientOptions = {},
    events: RpcClientEvents = {}
  ): Promise<RuntimeRpcClient | null> {
    if (!cli.available) return null
    const proc = spawn(cli.path ?? cli.command, ['--mode', 'rpc', ...(opts.args ?? [])], {
      cwd: opts.cwd ?? homedir(),
      env: resolveSubprocessEnv(opts.envMode ?? 'inherit', {
        PATH: executableSearchDirs().join(path.delimiter),
        HOME: homedir(),
        FORCE_COLOR: '0',
        ...(opts.env ?? {})
      })
    })
    const stderr = { text: '' }
    proc.stderr?.on('data', (c: Buffer) => {
      stderr.text = (stderr.text + c.toString('utf8')).slice(-2000)
    })
    const session = new OmpSession(
      {
        id: `probe-${Date.now()}`,
        cwd: opts.cwd ?? homedir(),
        title: 'probe',
        createdAt: Date.now(),
        status: 'idle'
      },
      proc as unknown as OmpProcessLike,
      {
        label: cli.command,
        onEvent: (e) => events.onEvent?.(e),
        onOpenUrl: events.onOpenUrl
      }
    )
    const client = new RuntimeRpcClient(session)
    proc.on('exit', (code) => events.onExit?.(code, stderr.text.trim().split('\n').pop() ?? ''))
    const probe = await session.query({ type: 'get_state' }, 10_000)
    if (!probe || probe.success !== true) {
      client.kill()
      return null
    }
    return client
  }

  /** Spawn, retrying with the zero-auth bootstrap env when the runtime has no models. */
  static async spawnWithBootstrap(
    cli: CliInfo,
    opts: RpcClientOptions = {},
    events: RpcClientEvents = {}
  ): Promise<{ client: RuntimeRpcClient; bootstrap: boolean } | null> {
    const plain = await RuntimeRpcClient.spawn(cli, opts, events)
    if (plain) return { client: plain, bootstrap: false }
    const boot = await RuntimeRpcClient.spawn(
      cli,
      {
        ...opts,
        env: { [BOOTSTRAP_ENV_KEY]: BOOTSTRAP_ENV_VALUE, ...(opts.env ?? {}) }
      },
      events
    )
    return boot ? { client: boot, bootstrap: true } : null
  }

  query(command: Record<string, unknown>, timeoutMs = 10_000) {
    return this.session.query(command, timeoutMs)
  }

  /** Respond to an interactive extension UI request (login prompts). */
  respond(requestId: string, answer: ExtensionUiAnswer): boolean {
    return this.session.respondExtensionUi(requestId, answer)
  }

  kill(): void {
    this.session.kill()
  }
}
