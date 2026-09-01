import { spawn, ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { CliInfo, Language, PermissionMode, SessionThinkingLevel } from '../../shared/types'
import { getStore } from '../store'
import { buildAgentArgs } from '../languageArgs'
import { executableSearchDirs } from './OmpCapabilities'
import { EnvMode, resolveSubprocessEnv } from './env'

/**
 * Process assembly for `pi --mode rpc` sessions: CLI argument construction
 * (permission-mode flags, approval extension, session resume, language
 * steering), the spawn environment, per-session approval config files, and
 * the bounded stderr capture used for crash diagnostics.
 */

/** Path of the bundled per-tool approval extension shipped with the GUI. */
function approvalExtensionPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'omp-approval', 'index.ts')
    : path.join(app.getAppPath(), 'resources', 'omp-approval', 'index.ts')
}

export interface ApprovalConfig {
  mode: 'off' | 'writes' | 'all'
  locale?: 'zh' | 'en'
}

/** Per-session approval config file path (one per session — see below). */
export function approvalConfigPath(sessionId: string): string {
  return path.join(app.getPath('userData'), `omp-approval-config-${sessionId}.json`)
}

/**
 * Write the approval extension config for a new session. Each session gets
 * its own file so concurrently running sessions with different modes never
 * clobber each other; the extension re-reads it (mtime-cached) on every
 * tool call.
 */
export function writeApprovalConfig(sessionId: string, config: ApprovalConfig): string {
  const file = approvalConfigPath(sessionId)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2))
  return file
}

/** Drop a session's approval config file (already gone is fine). */
export function removeApprovalConfig(sessionId: string): void {
  try {
    unlinkSync(approvalConfigPath(sessionId))
  } catch {
    // already gone — fine
  }
}

/**
 * Map the permission mode to CLI flags plus an approval config:
 * - full:      every tool enabled, approval extension inert
 * - no-bash:   bash excluded, approval extension inert
 * - readonly:  bash/edit/write excluded, approval extension inert
 * - ask:       every tool enabled, extension asks before bash/edit/write
 */
export function resolvePermissionMode(mode: PermissionMode): {
  excludeTools: string | null
  approval: ApprovalConfig
} {
  switch (mode) {
    case 'no-bash':
      return { excludeTools: 'bash', approval: { mode: 'off' } }
    case 'readonly':
      return { excludeTools: 'bash,edit,write', approval: { mode: 'off' } }
    case 'ask':
      return { excludeTools: null, approval: { mode: 'writes', locale: getStore('language') } }
    case 'full':
    default:
      return { excludeTools: null, approval: { mode: 'off' } }
  }
}

/**
 * Current Oh My Pi dropped `--exclude-tools`; the equivalents are the
 * `--tools` allowlist and the native approval modes (`--approval-mode`).
 * Verified against omp 17.2.12 (docs/protocol-facts.md):
 * - always-ask auto-approves read-only tools, prompts for write+exec —
 *   that is exactly the GUI's 'ask' mode;
 * - yolo auto-approves everything — the GUI's 'full' mode (passed
 *   explicitly so a user's own config.yml cannot turn prompts on);
 * - tool tiers without an upstream approval equivalent go through the
 *   allowlist: no-bash drops every execution-tier tool (bash and python),
 *   readonly keeps navigation/inspection only. `task` is excluded from both
 *   (subagent tool inheritance is not verified) and `computer` stays off
 *   (upstream default).
 */
const OMP_READONLY_TOOLS = ['read', 'grep', 'glob', 'lsp', 'inspect_image', 'web_search', 'todo']
const OMP_NO_BASH_TOOLS = [...OMP_READONLY_TOOLS, 'edit', 'write', 'notebook', 'browser']

export interface CurrentPermissionPlan {
  tools?: string
  approvalMode?: 'always-ask' | 'write' | 'yolo'
}

export function resolvePermissionModeCurrent(mode: PermissionMode): CurrentPermissionPlan {
  switch (mode) {
    case 'no-bash':
      return { tools: OMP_NO_BASH_TOOLS.join(','), approvalMode: 'yolo' }
    case 'readonly':
      return { tools: OMP_READONLY_TOOLS.join(','), approvalMode: 'yolo' }
    case 'ask':
      return { approvalMode: 'always-ask' }
    case 'full':
    default:
      return { approvalMode: 'yolo' }
  }
}

export interface SpawnOptions {
  permissionMode: PermissionMode
  language: Language
  /** Persisted session file to resume (history panel). */
  resumeSessionPath?: string
  /** One-shot session-scoped model override (--model spawn arg). */
  modelSelector?: string
  /** One-shot session-scoped thinking override (--thinking spawn arg). */
  thinkingLevel?: SessionThinkingLevel
  /** `inherit` (production default) or `replace` (test isolation). */
  envMode?: EnvMode
}

export interface SpawnPlan {
  /** Resolved executable path (falls back to the bare command name). */
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** Side effect of planning: the config file written for this session. */
  approvalConfigFile: string
}

/**
 * Assemble everything needed to spawn a session process. Planning writes
 * the per-session approval config file as a side effect (the path goes into
 * the environment).
 */
export function planSpawn(sessionId: string, cli: CliInfo, opts: SpawnOptions): SpawnPlan {
  // pi loads installed packages (settings.json) and auto-discovered extension
  // dirs itself on startup; the GUI manages them through the Packages page.
  const args = ['--mode', 'rpc']
  // Tool gating is profile-specific: legacy pi takes --exclude-tools plus the
  // bundled approval extension; current omp takes --tools / --approval-mode
  // (its native prompts arrive as ordinary extension_ui_request dialogs).
  const isCurrent = cli.command === 'omp'
  let approval: ApprovalConfig = { mode: 'off' }
  if (isCurrent) {
    const plan = resolvePermissionModeCurrent(opts.permissionMode)
    if (plan.tools) args.push('--tools', plan.tools)
    if (plan.approvalMode) args.push('--approval-mode', plan.approvalMode)
  } else {
    const legacy = resolvePermissionMode(opts.permissionMode)
    approval = legacy.approval
    if (legacy.excludeTools) {
      args.push('--exclude-tools', legacy.excludeTools)
    }
    const approvalExtension = approvalExtensionPath()
    if (existsSync(approvalExtension)) {
      args.push('-e', approvalExtension)
    }
  }
  // Resume a persisted session file when requested (history panel).
  if (opts.resumeSessionPath) {
    args.push('--session', opts.resumeSessionPath)
  }
  // One-shot session-scoped overrides from the composer pickers. These are
  // spawn args of exactly this session — the runtime default stays untouched.
  if (opts.modelSelector) {
    args.push('--model', opts.modelSelector)
  }
  if (opts.thinkingLevel) {
    args.push('--thinking', opts.thinkingLevel)
  }
  // Inject the 投手 ad-optimizer persona and steer the reply language.
  args.push(...buildAgentArgs(opts.language))

  const approvalConfigFile = writeApprovalConfig(sessionId, approval)
  return {
    command: cli.path ?? cli.command,
    args,
    env: resolveSubprocessEnv(opts.envMode ?? 'inherit', {
      PATH: executableSearchDirs().join(path.delimiter),
      HOME: homedir(),
      FORCE_COLOR: '0',
      OMP_APPROVAL_CONFIG: approvalConfigFile
    }),
    approvalConfigFile
  }
}

/** Spawn the session process described by a SpawnPlan. */
export function spawnProcess(plan: SpawnPlan, cwd: string): ChildProcess {
  return spawn(plan.command, plan.args, {
    cwd,
    env: plan.env,
    shell: process.platform === 'win32' && plan.command.toLowerCase().endsWith('.cmd')
  })
}
