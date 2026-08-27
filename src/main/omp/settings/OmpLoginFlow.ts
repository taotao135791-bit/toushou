import { CliInfo, LoginAnswer, LoginState } from '../../../shared/types'
import { RuntimeRpcClient } from './RuntimeRpcClient'

/**
 * One native login flow against current Oh My Pi, riding the RPC `login`
 * command (verified 17.2.12 — docs/settings-auth.md):
 *
 *   login {providerId}
 *     → extension_ui_request open_url   (OAuth / key dashboard → browser)
 *     → extension_ui_request input      (paste API key, 10 min timeout)
 *     → extension_ui_request select/confirm (OAuth choices)
 *     → extension_ui_request notify     ("Validating…")
 *     → response {success, error?}      (final verdict, provider-validated)
 *
 * The flow is a state machine (`LoginState`); the renderer only renders it.
 * Cancellation kills the probe process — there is no half-open background
 * login after Cancel. Secrets pass through the main process only, straight
 * into the runtime's extension_ui_response channel.
 */

/** Login prompts allow 10 minutes of user time; the probe itself is patient. */
const LOGIN_RESPONSE_TIMEOUT_MS = 12 * 60_000

export interface LoginFlowOptions {
  cli: CliInfo
  onState: (state: LoginState) => void
  /** Trusted URL open (validated by the caller — https or loopback only). */
  onOpenUrl: (url: string) => void
  /** Probe factory (injectable for tests). */
  spawnProbe?: typeof RuntimeRpcClient.spawnWithBootstrap
}

export class OmpLoginFlow {
  private client: RuntimeRpcClient | null = null
  private providerId = ''
  private finished = false
  /** When set, the first `input` prompt is auto-answered with this key. */
  private autoKey: string | null = null

  constructor(private readonly opts: LoginFlowOptions) {}

  private setState(state: LoginState): void {
    this.currentState = state
    this.opts.onState(state)
  }

  get active(): boolean {
    return !this.finished
  }

  /**
   * Set an API key for a provider and resolve when the flow settles.
   * Reuses the exact `login` flow + read-after-write verification, but
   * auto-answers the runtime's "paste API key" prompt with `key`.
   */
  async setApiKey(providerId: string, key: string): Promise<LoginState> {
    this.autoKey = key
    try {
      await this.start(providerId)
      return this.currentState
    } finally {
      this.autoKey = null
    }
  }

  async start(providerId: string): Promise<void> {
    this.providerId = providerId
    this.setState({ status: 'starting', providerId })
    const spawn = this.opts.spawnProbe ?? RuntimeRpcClient.spawnWithBootstrap
    const spawned = await spawn(
      this.opts.cli,
      { args: ['--no-extensions'] },
      {
        onEvent: (event) => this.handleEvent(event),
        // Do NOT auto-open a browser here: key-based providers (DeepSeek,
        // OpenRouter, xAI, …) emit `open_url` just to point at the API-key
        // dashboard before showing the paste-key input. Opening a browser
        // unprompted turns every such provider into a browser-login and
        // confuses key entry. The URL is stashed in state and opened only
        // when the user explicitly clicks.
        onOpenUrl: (url, launchUrl, instructions) => {
          this.setState({
            status: 'waiting_for_browser',
            providerId,
            url,
            launchUrl,
            instructions
          })
        },
        onExit: () => {
          if (!this.finished) {
            this.finish({ status: 'failed', providerId, message: 'Oh My Pi exited during login.' })
          }
        }
      }
    )
    if (!spawned) {
      this.finish({ status: 'failed', providerId, message: 'Oh My Pi could not start for login.' })
      return
    }
    this.client = spawned.client

    const res = await this.client.query(
      { type: 'login', providerId },
      LOGIN_RESPONSE_TIMEOUT_MS
    )
    if (this.finished) return // cancelled meanwhile
    // The login session is done either way — release it before verifying.
    this.client.kill()
    this.client = null
    if (res && res.success === true) {
      await this.verify(providerId)
    } else {
      const message =
        typeof res?.error === 'string'
          ? res.error
          : 'Oh My Pi did not answer the login request.'
      this.finish({ status: 'failed', providerId, message })
    }
  }

  /**
   * Read-after-write: a `success` from the login command is not proof the
   * credential works. Re-query the runtime's provider list and only report
   * Connected when the runtime itself confirms authentication.
   */
  private async verify(providerId: string): Promise<void> {
    this.setState({ status: 'verifying', providerId })
    const spawn = this.opts.spawnProbe ?? RuntimeRpcClient.spawnWithBootstrap
    const spawned = await spawn(this.opts.cli, { args: ['--no-extensions'] }, {})
    if (!spawned) {
      this.finish({
        status: 'failed',
        providerId,
        message: 'Login finished, but verification could not start.'
      })
      return
    }
    try {
      const res = await spawned.client.query({ type: 'get_login_providers' }, 10_000)
      const data = res?.data as
        | { providers?: Array<{ id?: unknown; authenticated?: unknown }> }
        | undefined
      const me = Array.isArray(data?.providers)
        ? data.providers.find((p) => p.id === providerId)
        : undefined
      if (me?.authenticated === true) {
        this.finish({ status: 'connected', providerId })
      } else {
        this.finish({
          status: 'failed',
          providerId,
          message: 'Oh My Pi did not confirm the new credential.'
        })
      }
    } finally {
      spawned.client.kill()
    }
  }

  private handleEvent(event: { type: string; [k: string]: unknown }): void {
    if (this.finished) return
    if (event.type === 'ui_request') {
      const requestId = String(event.id ?? '')
      const timeoutMs = typeof event.timeout === 'number' ? event.timeout : undefined
      switch (event.method) {
        case 'input':
          // Auto-answer when a key was pre-supplied (setApiKey): never block
          // on the interactive input prompt in that case.
          if (this.autoKey !== null && this.client) {
            this.client.respond(requestId, { value: this.autoKey })
            return
          }
          this.setState({
            status: 'waiting_for_input',
            providerId: this.providerId,
            requestId,
            title: String(event.title ?? ''),
            placeholder: typeof event.placeholder === 'string' ? event.placeholder : undefined,
            timeoutMs
          })
          return
        case 'select':
          this.setState({
            status: 'waiting_for_select',
            providerId: this.providerId,
            requestId,
            title: String(event.title ?? ''),
            options: Array.isArray(event.options) ? (event.options as string[]) : [],
            timeoutMs
          })
          return
        case 'confirm':
          this.setState({
            status: 'waiting_for_confirm',
            providerId: this.providerId,
            requestId,
            title: String(event.title ?? ''),
            message: typeof event.message === 'string' ? event.message : undefined,
            timeoutMs
          })
          return
      }
      return
    }
    if (event.type === 'ui_cancel') {
      // The runtime withdrew its prompt — the next state update replaces it.
      return
    }
    if (event.type === 'message' && event.role === 'system') {
      // notify frames ("Validating API key…") — progress, not chat.
      this.setState({
        status: 'verifying',
        providerId: this.providerId,
        message: String(event.content ?? '')
      })
    }
  }

  /** Answer the pending prompt; returns false when the flow is gone. */
  answer(answer: LoginAnswer): boolean {
    if (this.finished || !this.client) return false
    if ('cancelled' in answer) {
      this.cancel()
      return true
    }
    // The request id is embedded in the current state; the client checks.
    const state = this.currentState
    const requestId = 'requestId' in state ? state.requestId : ''
    if (!requestId) return false
    return this.client.respond(requestId, answer)
  }

  private currentState: LoginState = { status: 'idle' }

  cancel(): void {
    if (this.finished) return
    this.finish({ status: 'cancelled', providerId: this.providerId })
  }

  private finish(state: LoginState): void {
    this.finished = true
    this.setState(state)
    this.client?.kill()
    this.client = null
  }
}
