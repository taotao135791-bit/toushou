/**
 * Subprocess environment assembly. The GUI spawns `omp`/`pi` in two modes:
 *
 * - `inherit` (production): the child sees the host environment plus the
 *   GUI-owned overrides (PATH search dirs, HOME, FORCE_COLOR, approval config).
 * - `replace` (integration): the child sees ONLY the caller-supplied
 *   environment. The isolated test root (HOME / PI_CODING_AGENT_DIR) is the
 *   whole environment — `process.env` is never re-merged, so a test can never
 *   leak the developer's real credentials or agent directory into the child.
 *
 * One helper, used by every subprocess spawn path, so "test isolated env" and
 * "production inherited env" stay a single, auditable decision.
 */

export type EnvMode = 'inherit' | 'replace'

/** Assemble a child process environment from an override set and a mode. */
export function resolveSubprocessEnv(
  mode: EnvMode,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  return mode === 'replace' ? { ...overrides } : { ...process.env, ...overrides }
}
