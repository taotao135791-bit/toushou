import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnCommand } from '../../command'
import { prepareIsolatedAiHome } from '../../htmlBoardAi'
import { detectCli, executableSearchDirs } from '../../omp/OmpCapabilities'
import { configGet, configPath, type CliRunner } from '../../omp/settings/OmpConfigCli'
import { isValidModelSelector } from '../../omp/settings/modelSelector'

const TURN_TIMEOUT_MS = 90_000
const CONFIG_TIMEOUT_MS = 10_000
const MAX_INPUT = 4_000
const MAX_REPLY = 6_000
const MAX_HISTORY_TURNS = 4
const MAX_HISTORY_TEXT = 1_200
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

const systemPrompt = [
  '你是投手在钉钉中的对话助手，面向广告投放优化师。用对方使用的语言回答。',
  '先给结论。复杂问题可用简短条目区分已知数据、判断依据和待核实的假设。',
  '只使用这段对话中提供的信息和你的知识。需要看板、广告账号或其他实时数据时，说明缺少哪些信息。不要捏造数值或声称已查找、发送或修改。',
  '只输出要回复的正文，通常控制在 1000 个中文字以内。'
].join('\n')

const modelArgs = [
  '--mode', 'json', '--print', '--no-session', '--no-tools', '--no-extensions',
  '--no-skills', '--no-rules', '--no-lsp', '--no-pty', '--no-title', '--no-prewalk',
  '--max-time=90', '--thinking=off', '--system-prompt', systemPrompt
]

interface Turn {
  user: string
  assistant: string
}

interface DingTalkChatDependencies {
  cli?: typeof detectCli
  spawn?: typeof spawnCommand
  timeoutMs?: number
}

type RunResult = Awaited<ReturnType<CliRunner>>

function plainText(value: string, limit: number): string {
  const text = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1).replace(/[\ud800-\udbff]$/, '')}…`
}

function cliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Windows environment keys are case insensitive. A learned `Path` must not
  // take priority over the same search path used to locate the OMP launcher.
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PATH'))
  result.PATH = executableSearchDirs().join(path.delimiter)
  return result
}

function runCommand(
  spawn: typeof spawnCommand,
  command: string,
  args: string[],
  options: SpawnOptions,
  signal: AbortSignal,
  timeoutMs?: number
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return }
    const failure = { ok: false, stdout: '', stderr: '' }
    let child: ChildProcess
    try {
      child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      resolve(failure)
      return
    }

    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      return true
    }
    const kill = () => {
      // spawnCommand also terminates launcher descendants on Windows.
      try { child.kill('SIGKILL') } catch { /* the process may have already exited */ }
    }
    const finish = (ok: boolean, terminate = false) => {
      if (!cleanup()) return
      if (terminate) kill()
      resolve(ok ? { ok, stdout: Buffer.concat(chunks, bytes).toString('utf8'), stderr: '' } : failure)
    }
    const onAbort = () => {
      if (!cleanup()) return
      kill()
      reject(new Error('cancelled'))
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) { finish(false, true); return }
      chunks.push(chunk)
    })
    child.stderr?.resume()
    child.on('error', () => finish(false))
    child.once('close', code => finish(code === 0))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else if (timeoutMs !== undefined) timer = setTimeout(() => finish(false, true), timeoutMs)
  })
}

function readReply(stdout: string): string {
  let reply = ''
  for (const line of stdout.split('\n')) {
    let event: { type?: string; message?: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: unknown } | null> } } | null
    try { event = JSON.parse(line) } catch { continue }
    if (event?.type !== 'message_end' || event.message?.role !== 'assistant') continue
    const { stopReason, content } = event.message
    if (stopReason && stopReason !== 'stop' && stopReason !== 'length') return ''
    if (!Array.isArray(content) || content.some(part => part?.type === 'toolCall')) return ''
    reply = content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('')
  }
  return plainText(reply, MAX_REPLY)
}

/** A single DingTalk chat's short-lived model context, with a fresh OMP home per turn. */
export class DingTalkChat {
  private history: Turn[] = []
  private active?: AbortController

  constructor(private readonly deps: DingTalkChatDependencies = {}) {}

  reset(): void {
    this.history = []
    this.active?.abort()
    this.active = undefined
  }

  async turn(text: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('cancelled')
    if (this.active) throw new Error('failed')
    const user = plainText(text, MAX_INPUT)
    if (!user) throw new Error('invalid-input')

    const owner = new AbortController()
    this.active = owner
    const turnSignal = AbortSignal.any([owner.signal, signal])
    const timer = setTimeout(() => owner.abort('timeout'), Math.min(this.deps.timeoutMs ?? TURN_TIMEOUT_MS, TURN_TIMEOUT_MS))
    try {
      const reply = await this.request(user, turnSignal).catch(() => '')
      if (turnSignal.aborted) throw new Error(owner.signal.reason === 'timeout' ? 'timeout' : 'cancelled')
      if (reply === null) throw new Error('unavailable')
      if (!reply) throw new Error('failed')

      this.history = [...this.history, { user: plainText(user, MAX_HISTORY_TEXT), assistant: plainText(reply, MAX_HISTORY_TEXT) }].slice(-MAX_HISTORY_TURNS)
      return reply
    } finally {
      clearTimeout(timer)
      if (this.active === owner) this.active = undefined
    }
  }

  private async request(user: string, signal: AbortSignal): Promise<string | null> {
    const cli = (this.deps.cli ?? detectCli)()
    if (!cli.available || cli.command !== 'omp') return null
    const command = cli.path ?? cli.command
    const spawn = this.deps.spawn ?? spawnCommand
    const cwd = mkdtempSync(path.join(tmpdir(), 'toushou-dingtalk-'))
    try {
      // Configuration commands only see local settings. The model gets chat
      // text after those commands exit and only in its isolated environment.
      const configEnv = cliEnv(process.env)
      const runConfig: CliRunner = args => runCommand(spawn, command, args, { cwd, env: configEnv }, signal, CONFIG_TIMEOUT_MS)
      const [modelRoles, sourceAgent] = await Promise.all([configGet(runConfig, 'modelRoles'), configPath(runConfig)])
      signal.throwIfAborted()
      if (!modelRoles || !sourceAgent) return null
      const value = modelRoles.value as { default?: unknown } | undefined
      const selector = typeof value?.default === 'string' ? value.default : ''
      if (selector && !isValidModelSelector(selector)) return null
      const env = cliEnv(prepareIsolatedAiHome(path.join(cwd, 'home'), sourceAgent, selector))
      const prompt = JSON.stringify({ previousTurns: this.history, currentMessage: user })
      writeFileSync(path.join(cwd, 'prompt.md'), prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' })

      const args = [...modelArgs, ...(selector ? [`--model=${selector}`] : []), '@prompt.md']
      const result = await runCommand(spawn, command, args, { cwd, env }, signal)
      return result.ok ? readReply(result.stdout) : ''
    } finally {
      try { rmSync(cwd, { recursive: true, force: true }) } catch { /* best effort after process shutdown */ }
    }
  }
}
