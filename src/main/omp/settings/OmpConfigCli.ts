import { execFile } from 'node:child_process'
import path from 'node:path'
import { EnvMode, resolveSubprocessEnv } from '../env'

/**
 * Thin wrapper over `omp config list|get|set|reset --json` — the official
 * configuration interface of current Oh My Pi (verified against 17.2.12;
 * see docs/settings-auth.md). Never touches config.yml / *.db directly:
 * storage is the runtime's business, the CLI is the contract.
 *
 * Pure Node + injected runner for unit tests.
 */

export interface OmpConfigEntry {
  key: string
  value?: unknown
  type?: string
  description?: string
}

export type CliRunner = (
  args: string[]
) => Promise<{ ok: boolean; stdout: string; stderr: string }>

const DEFAULT_TIMEOUT_MS = 10_000

export interface CliRunnerOptions {
  /** Extra environment overrides (e.g. PI_CODING_AGENT_DIR / HOME for isolation). */
  env?: NodeJS.ProcessEnv
  /**
   * `inherit` merges `env` over the host `process.env` (production default);
   * `replace` uses ONLY `env`, so a test-isolated root is the whole
   * environment and the developer's real credentials never leak in.
   */
  envMode?: EnvMode
  timeoutMs?: number
}

/**
 * Default runner: execFile with argv (never a shell string). Production
 * (`envMode: 'inherit'`) merges `env` over `process.env`; integration
 * (`envMode: 'replace'`) uses only the injected `env` so an isolated test
 * root can be passed without the child re-absorbing the host environment.
 */
export function makeExecRunner(
  executable: string,
  options: CliRunnerOptions | number = {}
): CliRunner {
  const { env, envMode = 'inherit', timeoutMs = DEFAULT_TIMEOUT_MS } =
    typeof options === 'number' ? { timeoutMs: options } : options
  return (args) =>
    new Promise((resolve) => {
      execFile(
        executable,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          env: resolveSubprocessEnv(envMode, env ?? {})
        },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : ''
          })
        }
      )
    })
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Parse the directory emitted by the official `omp config path` command. */
export function parseConfigPath(raw: string): string | null {
  const candidates = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const configDir = candidates.find((line) => path.isAbsolute(line))
  return configDir ?? null
}

/** `omp config path` — the supported way to locate current OMP configuration. */
export async function configPath(run: CliRunner): Promise<string | null> {
  const res = await run(['config', 'path'])
  return res.ok ? parseConfigPath(res.stdout) : null
}

/** `omp config get <key> --json` → entry. Null on failure/unknown key. */
export async function configGet(run: CliRunner, key: string): Promise<OmpConfigEntry | null> {
  const res = await run(['config', 'get', key, '--json'])
  if (!res.ok) return null
  const parsed = parseJson(res.stdout)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const e = parsed as Record<string, unknown>
  return {
    key: typeof e.key === 'string' ? e.key : key,
    value: 'value' in e ? e.value : undefined,
    type: typeof e.type === 'string' ? e.type : undefined,
    description: typeof e.description === 'string' ? e.description : undefined
  }
}

/**
 * `omp config set <key> <value> --json`. Values are serialized exactly as
 * the CLI expects: scalars verbatim, objects/arrays as JSON.
 */
export async function configSet(run: CliRunner, key: string, value: unknown): Promise<boolean> {
  const serialized =
    typeof value === 'string' ? value : JSON.stringify(value ?? null)
  const res = await run(['config', 'set', key, serialized, '--json'])
  return res.ok
}

/** `omp config reset <key>` — back to the runtime default. */
export async function configReset(run: CliRunner, key: string): Promise<boolean> {
  const res = await run(['config', 'reset', key, '--json'])
  return res.ok
}

/** `omp auth-broker logout <provider>` — official credential removal. */
export async function authBrokerLogout(run: CliRunner, providerId: string): Promise<boolean> {
  const res = await run(['auth-broker', 'logout', providerId])
  return res.ok
}
