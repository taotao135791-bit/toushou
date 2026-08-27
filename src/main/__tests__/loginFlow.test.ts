import { describe, it, expect, vi } from 'vitest'
import { OmpLoginFlow } from '../omp/settings/OmpLoginFlow'
import { RuntimeRpcClient } from '../omp/settings/RuntimeRpcClient'
import { CliInfo, ExtensionUiAnswer, LoginState } from '../../shared/types'

/**
 * Login flow state machine with a fully fake probe client — covers the
 * documented native flow: open_url → input → notify → response verdict,
 * plus cancel, failure and mid-flow crash. The login response is a deferred
 * the test settles after emitting the flow's events.
 */

const CLI: CliInfo = { command: 'omp', path: '/usr/local/bin/omp', available: true }

interface FakeClient {
  query: ReturnType<typeof vi.fn>
  respond: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  emit: (event: Record<string, unknown>) => void
  openUrl: (url: string, launchUrl?: string, instructions?: string) => void
  exit: (code: number) => void
  resolveLogin: (response: Record<string, unknown> | null) => void
}

function makeFlow(opts: { spawnNull?: boolean; authenticated?: boolean } = {}) {
  const states: LoginState[] = []
  const urls: string[] = []
  let eventCb: ((event: Record<string, unknown>) => void) | null = null
  let urlCb: ((url: string, launchUrl?: string, instructions?: string) => void) | null = null
  let exitCb: ((code: number) => void) | null = null
  let resolveLogin: (response: Record<string, unknown> | null) => void = () => {}
  const client: FakeClient = {
    query: vi.fn((cmd: Record<string, unknown>, _t?: number) => {
      // Verification probe: answer provider state instead of deferring.
      if (cmd.type === 'get_login_providers') {
        return Promise.resolve({
          type: 'response',
          command: 'get_login_providers',
          success: true,
          data: {
            providers: [
              { id: 'deepseek', name: 'DeepSeek', available: true, authenticated: opts.authenticated !== false },
              { id: 'anthropic', name: 'Anthropic', available: true, authenticated: opts.authenticated !== false }
            ]
          }
        })
      }
      return new Promise((resolve) => {
        resolveLogin = resolve
      })
    }),
    respond: vi.fn((_id: string, _a: ExtensionUiAnswer) => true),
    kill: vi.fn(() => {}),
    emit: (event) => eventCb?.(event),
    openUrl: (url, launchUrl, instructions) => urlCb?.(url, launchUrl, instructions),
    exit: (code) => exitCb?.(code),
    resolveLogin: (response) => resolveLogin(response)
  }
  const spawnProbe: typeof RuntimeRpcClient.spawnWithBootstrap = async (
    _cli,
    _opts,
    events
  ) => {
    if (opts.spawnNull) return null
    eventCb = (e) => events?.onEvent?.(e as never)
    urlCb = (url, launchUrl, instructions) => events?.onOpenUrl?.(url, launchUrl, instructions)
    exitCb = (code) => events?.onExit?.(code, '')
    return { client: client as unknown as RuntimeRpcClient, bootstrap: false }
  }
  const flow = new OmpLoginFlow({
    cli: CLI,
    onState: (s) => states.push(s),
    onOpenUrl: (url) => urls.push(url),
    spawnProbe
  })
  return { flow, states, urls, client }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('OmpLoginFlow', () => {
  it('completes the api-key flow: open_url → input → verifying → connected', async () => {
    const { flow, states, urls, client } = makeFlow()
    const started = flow.start('deepseek')
    await vi.waitFor(() => expect(states.some((s) => s.status === 'starting')).toBe(true))
    client.openUrl(
      'https://platform.deepseek.com/api_keys',
      'http://localhost:43123/callback',
      'Create or locate your API key, then return here.'
    )
    client.emit({ type: 'ui_request', id: 'i1', method: 'input', title: 'Paste your DeepSeek API key', placeholder: 'sk-...' })
    await tick()
    expect(states.map((s) => s.status)).toEqual(['starting', 'waiting_for_browser', 'waiting_for_input'])
    // The URL is stashed in state now (explicit open), NOT auto-opened.
    const browserState = states.find((s) => s.status === 'waiting_for_browser') as
      | (LoginState & { status: 'waiting_for_browser' })
      | undefined
    expect(browserState?.url).toBe('https://platform.deepseek.com/api_keys')
    expect(browserState?.launchUrl).toBe('http://localhost:43123/callback')
    expect(browserState?.instructions).toBe('Create or locate your API key, then return here.')
    const answered = flow.answer({ value: 'sk-fake' })
    expect(answered).toBe(true)
    expect(client.respond).toHaveBeenCalledWith('i1', { value: 'sk-fake' })
    client.emit({ type: 'message', role: 'system', content: 'Validating API key...' })
    await tick()
    expect(states.at(-1)?.status).toBe('verifying')
    client.resolveLogin({ type: 'response', command: 'login', success: true, data: { providerId: 'deepseek' } })
    await started
    expect(states.at(-1)?.status).toBe('connected')
    // The success response alone is not enough — the flow re-queried the
    // runtime (verifying) before declaring Connected.
    expect(states.map((x) => x.status)).toContain('verifying')
    expect(client.query).toHaveBeenCalledWith({ type: 'get_login_providers' }, 10_000)
    expect(urls).toEqual([]) // no longer auto-opened — URL is stashed in state
    expect(client.kill).toHaveBeenCalled()
  })

  it('surfaces the provider error on a rejected key', async () => {
    const { flow, states, client } = makeFlow()
    const started = flow.start('deepseek')
    await vi.waitFor(() => expect(states.some((s) => s.status === 'starting')).toBe(true))
    client.resolveLogin({
      type: 'response',
      command: 'login',
      success: false,
      error: 'deepseek API key validation failed (401)'
    })
    await started
    const last = states.at(-1)
    expect(last?.status).toBe('failed')
    expect(last && 'message' in last && last.message).toContain('401')
  })

  it('login success without runtime confirmation is a failure, not Connected', async () => {
    const { flow, states, client } = makeFlow({ authenticated: false })
    const started = flow.start('deepseek')
    await vi.waitFor(() => expect(states.some((x) => x.status === 'starting')).toBe(true))
    client.resolveLogin({ type: 'response', command: 'login', success: true, data: { providerId: 'deepseek' } })
    await started
    const last = states.at(-1)
    expect(last?.status).toBe('failed')
    expect(last && 'message' in last && (last as { message: string }).message).toMatch(/did not confirm/)
  })

  it('cancel kills the runtime operation and reports cancelled', async () => {
    const { flow, states, client } = makeFlow()
    const started = flow.start('deepseek')
    await vi.waitFor(() => expect(states.some((s) => s.status === 'starting')).toBe(true))
    flow.cancel()
    client.resolveLogin(null) // the killed process never answers; harmless
    await started
    expect(states.at(-1)?.status).toBe('cancelled')
    expect(client.kill).toHaveBeenCalled()
    // Late answers after cancel are refused.
    expect(flow.answer({ value: 'x' })).toBe(false)
  })

  it('a mid-flow process exit fails the flow', async () => {
    const { flow, states, client } = makeFlow()
    const started = flow.start('deepseek')
    await vi.waitFor(() => expect(states.some((s) => s.status === 'starting')).toBe(true))
    client.exit(1)
    client.resolveLogin(null)
    await started
    expect(states.at(-1)?.status).toBe('failed')
    const last = states.at(-1)
    expect(last && 'message' in last && (last as { message: string }).message).toMatch(/exited/)
  })

  it('setApiKey auto-answers the paste-key prompt and verifies', async () => {
    const { flow, states, client } = makeFlow()
    const done = flow.setApiKey('deepseek', 'sk-direct')
    await vi.waitFor(() => expect(states.some((s) => s.status === 'starting')).toBe(true))
    client.openUrl('https://platform.deepseek.com/api_keys')
    client.emit({ type: 'ui_request', id: 'i1', method: 'input', title: 'Paste your DeepSeek API key' })
    await tick()
    // The key was auto-answered, never left waiting for manual input.
    expect(states.some((s) => s.status === 'waiting_for_input')).toBe(false)
    expect(client.respond).toHaveBeenCalledWith('i1', { value: 'sk-direct' })
    client.resolveLogin({ type: 'response', command: 'login', success: true, data: { providerId: 'deepseek' } })
    const state = await done
    expect(state.status).toBe('connected')
    expect(client.kill).toHaveBeenCalled()
  })

  it('reports failure when the runtime cannot start at all', async () => {
    const { flow, states } = makeFlow({ spawnNull: true })
    await flow.start('deepseek')
    expect(states.at(-1)?.status).toBe('failed')
  })

  it('maps select and confirm prompts', async () => {
    const { flow, states, client } = makeFlow()
    const started = flow.start('anthropic')
    await vi.waitFor(() => expect(states.some((s) => s.status === 'starting')).toBe(true))
    client.emit({ type: 'ui_request', id: 's1', method: 'select', title: 'Pick', options: ['a', 'b'] })
    await tick()
    expect(states.at(-1)?.status).toBe('waiting_for_select')
    flow.answer({ value: 'a' })
    expect(client.respond).toHaveBeenCalledWith('s1', { value: 'a' })
    client.emit({ type: 'ui_request', id: 'c1', method: 'confirm', title: 'Sure?' })
    await tick()
    expect(states.at(-1)?.status).toBe('waiting_for_confirm')
    flow.answer({ confirmed: true })
    expect(client.respond).toHaveBeenCalledWith('c1', { confirmed: true })
    flow.cancel()
    client.resolveLogin(null)
    await started
  })
})
