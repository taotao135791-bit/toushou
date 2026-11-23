import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DingTalkChat } from './DingTalkChat'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, dialog: {} }))

function assistant(text: string) {
  return { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } }
}

interface ModelCall {
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  models: string
  hasMcp: boolean
  prompt: { previousTurns: { user: string; assistant: string }[]; currentMessage: string }
  kill: ReturnType<typeof vi.fn>
}

const directories = new Set<string>()

function fixture(options: { modelOutput?: unknown; hold?: 'model' | 'config'; timeoutMs?: number } = {}) {
  const source = mkdtempSync(path.join(tmpdir(), 'dingtalk-chat-fixture-'))
  directories.add(source)
  const executable = path.join(source, 'omp.cmd')
  writeFileSync(path.join(source, 'models.yml'), 'providers:\n  openrouter:\n    apiKey: synthetic-only-model-key\n')
  writeFileSync(path.join(source, 'mcp.json'), 'private MCP configuration')
  writeFileSync(path.join(source, 'config.yml'), 'packages: [private-extension]\n')
  const calls: ModelCall[] = []
  const processes: ReturnType<typeof vi.fn>[] = []
  const spawn = vi.fn((_command: string, args: string[], opts: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => {
      child.emit('close', null)
      return true
    }) })
    const finish = (text: string, code = 0) => {
      const bytes = Buffer.from(text)
      for (let i = 0; i < bytes.length; i += 8) child.stdout.write(bytes.subarray(i, i + 8))
      child.emit('close', code)
    }
    processes.push(child.kill)
    if (args[0] === 'config') {
      if (options.hold !== 'config') queueMicrotask(() => finish(args[1] === 'path'
        ? source : JSON.stringify({ key: 'modelRoles', value: { default: 'openrouter/anthropic/synthetic-model' } })))
    } else {
      const cwd = String(opts.cwd)
      const env = opts.env ?? {}
      const agent = env.PI_CODING_AGENT_DIR ?? ''
      calls.push({
        args, cwd, env, kill: child.kill,
        hasMcp: existsSync(path.join(agent, 'mcp.json')),
        models: readFileSync(path.join(agent, 'models.yml'), 'utf8'),
        prompt: JSON.parse(readFileSync(path.join(cwd, 'prompt.md'), 'utf8'))
      })
      if (options.hold !== 'model') queueMicrotask(() => finish(JSON.stringify(options.modelOutput ?? assistant('建议先看分组数据 🧭'))))
    }
    return child as unknown as ChildProcess
  })
  const chat = new DingTalkChat({ spawn, timeoutMs: options.timeoutMs, cli: () => ({ path: executable, command: 'omp', available: true }) })
  return { chat, calls, processes, spawn }
}

const signal = () => new AbortController().signal

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.clear()
})

describe('DingTalkChat', () => {
  it('runs the configured model in a temporary tool-free home and keeps chat data out of argv', async () => {
    vi.stubEnv('TOUSHOU_FEISHU_TOKEN', 'synthetic-bridge-token')
    vi.stubEnv('PI_CONFIG_DIR', 'synthetic-host-config')
    const { chat, calls, spawn } = fixture()
    expect(await chat.turn('--请分析这一组数据 🔍', signal())).toBe('建议先看分组数据 🧭')
    const [call] = calls
    expect(call.prompt).toEqual({ previousTurns: [], currentMessage: '--请分析这一组数据 🔍' })
    expect(call.args).toEqual(expect.arrayContaining([
      '--model=openrouter/anthropic/synthetic-model', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-session', '@prompt.md'
    ]))
    expect(call.args.join(' ')).not.toContain('请分析')
    expect(call.env.HOME).toBe(path.join(call.cwd, 'home'))
    expect(call.env.PI_AUTO_QA).toBe('0')
    expect(call.env.PI_CONFIG_DIR).toBeUndefined()
    expect(call.env.TOUSHOU_FEISHU_TOKEN).toBeUndefined()
    expect(call.models).toContain('synthetic-only-model-key')
    expect(call.hasMcp).toBe(false)
    expect(existsSync(call.cwd)).toBe(false)
    expect(spawn.mock.calls[2][2].windowsHide).toBe(true)
  })

  it('bounds dialogue history, limits input, and clears context on reset', async () => {
    const { chat, calls } = fixture()
    for (let i = 0; i < 6; i++) await chat.turn(`消息 ${i}`, signal())
    await chat.turn('长'.repeat(5_000), signal())
    expect(calls[6].prompt.currentMessage).toHaveLength(4_000)
    expect(calls[6].prompt.previousTurns.map(turn => turn.user)).toEqual(['消息 2', '消息 3', '消息 4', '消息 5'])
    expect(calls[6].prompt.previousTurns[0].assistant).toBe('建议先看分组数据 🧭')
    chat.reset()
    await chat.turn('新的消息', signal())
    expect(calls[7].prompt).toEqual({ previousTurns: [], currentMessage: '新的消息' })
  })

  it('bounds long answers without breaking a surrogate pair', async () => {
    const { chat, calls } = fixture({ modelOutput: assistant('文'.repeat(5_998) + '🧭🧭') })
    const reply = await chat.turn('长回复', signal())
    expect(reply).toBe('文'.repeat(5_998) + '…')
    await chat.turn('继续', signal())
    expect(calls[1].prompt.previousTurns[0].assistant).toHaveLength(1_200)
  })

  it('kills the model on cancellation, removes its prompt, and never saves the turn', async () => {
    const { chat, calls } = fixture({ hold: 'model' })
    const controller = new AbortController()
    const turn = chat.turn('待取消的消息', controller.signal)
    const cancelled = expect(turn).rejects.toThrow(/^cancelled$/)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    controller.abort('sensitive reason')
    await cancelled
    expect(calls[0].kill).toHaveBeenCalledWith('SIGKILL')
    expect(existsSync(calls[0].cwd)).toBe(false)

    const retry = chat.turn('重新开始', signal())
    const reset = expect(retry).rejects.toThrow(/^cancelled$/)
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].prompt.previousTurns).toEqual([])
    chat.reset()
    await reset
    expect(calls[1].kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('applies the same hard deadline to settings reads and model inference', async () => {
    vi.useFakeTimers()
    const settings = fixture({ hold: 'config', timeoutMs: 20 })
    const preparing = settings.chat.turn('读取配置时超时', signal())
    const settingsTimedOut = expect(preparing).rejects.toThrow(/^timeout$/)
    await vi.advanceTimersByTimeAsync(20)
    await settingsTimedOut
    expect(settings.processes).toHaveLength(2)
    for (const kill of settings.processes) expect(kill).toHaveBeenCalledWith('SIGKILL')
    expect(settings.calls).toHaveLength(0)

    const running = fixture({ hold: 'model' })
    const speaking = running.chat.turn('等待模型时超时', signal())
    const modelTimedOut = expect(speaking).rejects.toThrow(/^timeout$/)
    await vi.advanceTimersByTimeAsync(89_999)
    expect(running.calls[0].kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await modelTimedOut
    expect(running.calls[0].kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('keeps provider diagnostics and attempted tool calls out of replies', async () => {
    const provider = fixture({ modelOutput: { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'private provider diagnostic' } } })
    await expect(provider.chat.turn('你好', signal())).rejects.toThrow(/^failed$/)
    const tool = fixture({ modelOutput: { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'toolCall' }, { type: 'text', text: '伪造的工具结果' }] } } })
    await expect(tool.chat.turn('你好', signal())).rejects.toThrow(/^failed$/)
  })
})
