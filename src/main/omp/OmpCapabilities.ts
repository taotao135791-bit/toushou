import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { CliCapabilities, CliInfo, SessionState, CapabilityState, RpcOutcome } from '../../shared/types'
import { HandshakeOutcome } from './OmpHandshake'

/**
 * CLI detection and capability probing.
 *
 * Detection finds the `omp`/`pi` executable (GUI apps get a minimal PATH, so
 * well-known package-manager bin dirs are searched too). Capabilities come
 * from three probes, in increasing order of authority:
 * - `<cli> --version` at detect time → cliVersion;
 * - the session bootstrap handshake → runtime profile, negotiated RPC
 *   protocol version and frame limits (declared by the runtime itself);
 * - a live session's get_state response → confirms the RPC command surface
 *   even when the version probe fails (shim wrappers…).
 *
 * Feature flags flip on once the CLI proved responsive. RPC facts are never
 * guessed from version numbers — they come from the handshake alone.
 */

// Only successful detections are cached; a negative result is re-checked
// every time so the app picks up a CLI installed after launch.
let cliInfoCache: CliInfo | null = null
let capabilitiesCache: CliCapabilities | null = null
/** Handshake facts observed before the first getCapabilities() call. */
let pendingHandshake: HandshakeOutcome | null = null

export function detectCli(): CliInfo {
  if (cliInfoCache) return cliInfoCache

  for (const cmd of ['omp', 'pi']) {
    const candidate = findExecutable(cmd)
    if (candidate) {
      cliInfoCache = { command: cmd, path: candidate, available: true }
      return cliInfoCache
    }
  }

  return { command: 'omp', available: false }
}

/** Clear the cached CLI info and capabilities (e.g. after a successful install). */
export function invalidateCliCache(): void {
  cliInfoCache = null
  capabilitiesCache = null
  pendingHandshake = null
}

/**
 * GUI apps on macOS/Linux are launched with a minimal PATH that usually
 * excludes package-manager bin dirs, so check well-known locations too.
 */
export function executableSearchDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean)
  const home = homedir()
  dirs.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    // Default location of the official bun installer; omp shells out to bun
    // for plugin install/uninstall, so a standard bun setup must be visible
    // even though it is absent from a Finder-launched app's PATH.
    path.join(home, '.bun', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'bin')
  )
  if (platform === 'win32') {
    // Default install location of the official omp Windows installer
    // (install.ps1 writes omp.exe here).
    dirs.push(path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'omp'))
  }
  return Array.from(new Set(dirs))
}

/**
 * File names tried for a command. On Windows an installed executable is
 * `omp.exe`, not `omp`, so the bare name alone never matches. Only extensions
 * spawn can launch directly (no shell) are tried — `.bat`/`.cmd` shims would
 * need `shell: true` and are deliberately not matched.
 */
export function executableCandidateNames(
  cmd: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform !== 'win32') return [cmd]
  return [cmd, `${cmd}.exe`, `${cmd}.com`]
}

/** Find `cmd` in `dirs`, trying the platform's candidate file names. */
export function findExecutableInDirs(
  cmd: string,
  dirs: string[],
  platform: NodeJS.Platform = process.platform
): string | null {
  for (const dir of dirs) {
    for (const name of executableCandidateNames(cmd, platform)) {
      const full = path.join(dir, name)
      try {
        if (!existsSync(full) || !statSync(full).isFile()) continue
        accessSync(full, constants.X_OK)
        return full
      } catch {
        continue
      }
    }
  }
  return null
}

function findExecutable(cmd: string): string | null {
  return findExecutableInDirs(cmd, executableSearchDirs())
}

const VERSION_PROBE_TIMEOUT_MS = 10_000

/** Run `<cli> --version` and parse the first semver-ish token from its output. */
export function probeCliVersion(cli: CliInfo): Promise<string | null> {
  if (!cli.available) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      cli.path ?? cli.command,
      ['--version'],
      { timeout: VERSION_PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve(null)
          return
        }
        const match = `${stdout}\n${stderr}`.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
        resolve(match ? match[0] : null)
      }
    )
  })
}

/**
 * Static feature flags flipped on once the CLI proves responsive. These are
 * "generic runtime works" facts; the subagent capabilities are SEPARATE probed
 * facts and must never be reset by this (a get_state refresh must not turn a
 * proven `supported` subagent capability back to `unknown`).
 */
function featureMatrix(enabled: boolean): Omit<
  CliCapabilities,
  'cliVersion' | 'protocol' | 'subagents' | 'subagentProgress' | 'subagentMessages' | 'subagentControl'
> {
  return {
    steering: enabled,
    followUp: enabled,
    images: enabled,
    compaction: enabled,
    extensionUi: enabled,
    fork: enabled,
    thinking: enabled
  }
}

/** Subagent capabilities start unknown/unsupported and are only ever set by a real RPC outcome. */
const SUBAGENT_CAPABILITY_DEFAULTS: Pick<
  CliCapabilities,
  'subagents' | 'subagentProgress' | 'subagentMessages' | 'subagentControl'
> = {
  subagents: 'unknown',
  subagentProgress: 'unknown',
  subagentMessages: 'unknown',
  subagentControl: 'unsupported'
}

/** RPC facts declared by a settled handshake, mapped onto the capability shape. */
function handshakeFacts(outcome: HandshakeOutcome): Partial<CliCapabilities> {
  return {
    protocol: outcome.protocolVersion,
    profile: outcome.profile,
    ...(outcome.runtimeProtocols ? { protocolVersions: outcome.runtimeProtocols } : {}),
    ...(outcome.maxFrameBytes !== undefined ? { maxFrameBytes: outcome.maxFrameBytes } : {}),
    ...(outcome.maxReassembledFrameBytes !== undefined
      ? { maxReassembledFrameBytes: outcome.maxReassembledFrameBytes }
      : {})
  }
}

/**
 * Capabilities of the detected CLI. Feature flags are only advertised once the
 * CLI proved responsive — via the --version probe here, or via a runtime
 * get_state (noteSessionState).
 *
 * A failed --version probe is NOT cached as final: the first spawn of a cold
 * CLI (fresh install, Gatekeeper/bun warm-up) can exceed the probe timeout,
 * and a permanently cached "not detected" version makes Settings claim the
 * runtime is missing while everything else works. When the cache holds no
 * version, later calls trigger a fire-and-forget re-probe (at most once per
 * FAILED_VERSION_REPROBE_MS) and still answer immediately from the cache.
 */
const FAILED_VERSION_REPROBE_MS = 15_000
let lastFailedVersionProbeAt = 0

export async function getCapabilities(): Promise<CliCapabilities> {
  if (capabilitiesCache) {
    const cli = detectCli()
    if (cli.available && !capabilitiesCache.cliVersion && Date.now() - lastFailedVersionProbeAt > FAILED_VERSION_REPROBE_MS) {
      lastFailedVersionProbeAt = Date.now()
      void probeCliVersion(cli).then((cliVersion) => {
        if (cliVersion) {
          capabilitiesCache = {
            ...capabilitiesCache,
            cliVersion,
            ...featureMatrix(true)
          }
        }
      })
    }
    return capabilitiesCache
  }
  const cli = detectCli()
  const cliVersion = await probeCliVersion(cli)
  if (cli.available && !cliVersion) {
    lastFailedVersionProbeAt = Date.now()
  }
  capabilitiesCache = {
    cliVersion,
    protocol: pendingHandshake?.protocolVersion ?? 1,
    ...(pendingHandshake ? handshakeFacts(pendingHandshake) : {}),
    ...featureMatrix(cliVersion !== null),
    ...SUBAGENT_CAPABILITY_DEFAULTS
  }
  return capabilitiesCache
}

/**
 * Runtime probe, highest authority: a settled session bootstrap declares
 * the runtime profile, the negotiated RPC protocol version and the frame
 * limits. Called by OmpSession via its onHandshake callback.
 */
export function noteHandshake(outcome: HandshakeOutcome): void {
  pendingHandshake = outcome
  if (!capabilitiesCache) return
  capabilitiesCache = { ...capabilitiesCache, ...handshakeFacts(outcome) }
}

/**
 * Runtime probe: a successful get_state response proves this build answers
 * the RPC command surface (get_state rides with the rest of the command
 * set), so flip every feature flag on even when --version probing failed.
 * Called with the parsed get_state payload.
 */
export function noteSessionState(_state: SessionState): void {
  if (!capabilitiesCache) return
  capabilitiesCache = { ...capabilitiesCache, ...featureMatrix(true) }
}

/** Patch cached subagent capabilities once a real RPC response proves/disproves them. */
function noteSubagentCapability(patch: Partial<CliCapabilities>): void {
  if (capabilitiesCache) {
    capabilitiesCache = { ...capabilitiesCache, ...patch }
  }
}

/** Map a normalized RPC outcome to a capability state. */
function outcomeState(outcome: RpcOutcome<unknown>): CapabilityState {
  switch (outcome.kind) {
    case 'success':
    case 'command-error':
      // The runtime ANSWERED the command (even if this invocation failed) →
      // the command exists.
      return 'supported'
    case 'unsupported':
      return 'unsupported'
    case 'unknown':
      return 'unknown'
  }
}

/**
 * Record a subagent capability from a normalized RPC outcome. An `unknown`
 * outcome (timeout / transport / death) never overwrites a previously-known
 * state, so a transient timeout can't downgrade `supported` to `unknown`.
 */
export function noteSubagentCapabilityOutcome(
  field: 'subagents' | 'subagentProgress' | 'subagentMessages',
  outcome: RpcOutcome<unknown>
): void {
  const state = outcomeState(outcome)
  if (state === 'unknown') return
  noteSubagentCapability({ [field]: state })
}
