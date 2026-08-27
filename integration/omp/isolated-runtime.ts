import { execFileSync, spawn, ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Isolated Oh My Pi runtime environment for integration tests. Every test
 * that touches `--config`, session state, auth, or the agent directory gets
 * a fresh temp root; the developer's real `~/.omp`, auth, config and
 * credentials are NEVER inherited. This is the non-negotiable safety boundary
 * of `pnpm test:omp` (see README + docs/settings-auth.md).
 *
 * Relocation uses the official `PI_CODING_AGENT_DIR` mechanism (verified:
 * `omp config path` honors it), never guessed internal directory layouts.
 */

export interface IsolatedRuntime {
  /** Temp root (delete with cleanup()). */
  root: string
  /** Isolated agent dir (PI_CODING_AGENT_DIR). */
  agentDir: string
  /** Isolated HOME (so ~/.omp can never be the real one). */
  homeDir: string
  /** Environment for spawning omp/pi — credential-stripped, isolated. */
  env: NodeJS.ProcessEnv
  /** Path to the omp binary unless overridden via OMP_BIN. */
  ompBin: string
  /** Path to the pi binary unless overridden via PI_BIN (may not exist). */
  piBin: string
  /** Remove the whole temp root. Safe to call multiple times. */
  cleanup: () => void
  /** Open a long-running RPC process (stdio pipes) wired to the isolated env. */
  spawnRpc: (bin: string, extraArgs?: string[]) => ChildProcess
}

/** Credential-matching prefixes stripped from the isolated environment. */
const CREDENTIAL_ENV_RE =
  /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|GROQ|CEREBRAS|XAI|OPENROUTER|KILO|MISTRAL|ZAI|MINIMAX|OPENCODE|AI_GATEWAY|AZURE|AWS|TAVILY|BRAVE|PERPLEXITY|EXA|FIRECRAWL|TINYFISH|WAIFER|UMANS|UMANS_AI|DEEPSEEK|STEPFUN|MOONSHOT|KIMI)_?/i

export function stripCredentials(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(input)) {
    if (CREDENTIAL_ENV_RE.test(key)) continue
    if (key === 'OMP_GUI_RUN_LIVE_TESTS') continue
    out[key] = value
  }
  return out
}

/**
 * Build an isolated runtime environment. Each call returns a NEW directory,
 * so parallel suites (if any) can never share state. `credentials: false`
 * (default) removes every provider key even when the real HOME has one.
 */
export function createIsolatedOmpEnvironment(opts: { credentials?: boolean } = {}): IsolatedRuntime {
  const root = mkdtempSync(path.join(tmpdir(), 'omp-gui-it-'))
  const agentDir = path.join(root, 'agent')
  const homeDir = path.join(root, 'home')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })

  const ompBin = process.env.OMP_BIN || 'omp'
  const piBin = process.env.PI_BIN || 'pi'

  const base = opts.credentials === true ? { ...process.env } : stripCredentials(process.env)
  const env: NodeJS.ProcessEnv = {
    ...base,
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    FORCE_COLOR: '0',
    NO_COLOR: '1'
  }

  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // already gone — fine
    }
  }

  const spawnRpc = (bin: string, extraArgs: string[] = []): ChildProcess =>
    spawn(bin, ['--mode', 'rpc', ...extraArgs], {
      cwd: agentDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })

  return { root, agentDir, homeDir, env, ompBin, piBin, cleanup, spawnRpc }
}

/**
 * Run `<bin> <args>` synchronously in the isolated env. Returns the combined
 * stdout+stderr WITHOUT throwing on non-zero exit (we assert on the error
 * text itself, e.g. "Unknown setting" / "Invalid value").
 */
export function runOmp(env: NodeJS.ProcessEnv, bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { env, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string }
    return `${e.stdout ?? ''}\n${e.stderr ?? ''}`
  }
}

/** True when `<bin> --version` reports a usable binary. */
export function binaryAvailable(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { timeout: 10_000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Fail fast only for explicitly required runtimes. `OMP_REQUIRED=1` keeps the
 * historical "every suite is mandatory" behavior; a comma-separated list
 * (for example `OMP_REQUIRED=omp`) makes just those binaries release gates.
 * This lets CI require the pinned current OMP while keeping the separately
 * installed legacy-Pi suite an honest, visible skip.
 */
export function requireBinary(bin: string): void {
  if (!binaryAvailable(bin)) {
    const requirement = process.env.OMP_REQUIRED?.trim()
    const requiredBins = new Set(
      requirement && requirement !== '1'
        ? requirement
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
        : []
    )
    if (requirement === '1' || requiredBins.has(bin)) {
      throw new Error(`Required OMP binary '${bin}' not found (OMP_REQUIRED=${requirement})`)
    }
    console.warn(`[test:omp] Required OMP binary '${bin}' not found — skipping suite`)
  }
}

/** Assert that the isolated env did not touch the real user agent dir. */
export function realAgentDirAbsent(iso: IsolatedRuntime): void {
  // The real agent dir is the process's own HOME/.omp/agent; the isolated
  // env must never equal it.
  const real = path.join(process.env.HOME ?? '', '.omp', 'agent')
  if (iso.agentDir === real) throw new Error('isolated agent dir escaped to the real HOME')
}
