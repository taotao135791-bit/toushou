import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { win32 } from 'node:path'
import { shell } from 'electron'
import { OpenWorkspaceResult, OpenWorkspaceTarget } from '../shared/types'
import { spawnCommand } from './command'

/**
 * "Open with" launchers for the chat top bar utility menu: reveal the current
 * workspace in Finder / open it in a terminal / open it in VS Code.
 *
 * Security posture: the directory NEVER comes from the renderer. The IPC
 * handler in ipc.ts resolves the workspace grant id to its canonical realPath
 * (same authority as every other workspace-scoped channel) and only then calls
 * into this module. Targets are re-validated here so a stray value can never
 * reach a spawn call.
 */

const OPEN_WORKSPACE_TARGETS: readonly OpenWorkspaceTarget[] = ['finder', 'terminal', 'editor']
type WorkspaceLauncher = typeof spawnCommand

/** Narrow an untrusted IPC value to an OpenWorkspaceTarget. */
export function isOpenWorkspaceTarget(value: unknown): value is OpenWorkspaceTarget {
  return typeof value === 'string' && (OPEN_WORKSPACE_TARGETS as readonly string[]).includes(value)
}

/**
 * Spawn a fire-and-forget GUI process: detached + unref so the child outlives
 * the app window, stdio discarded, and the error event ALWAYS consumed — an
 * unhandled 'error' on a ChildProcess crashes Main.
 */
function spawnDetached(
  command: string, args: string[], onError: () => void, options?: SpawnOptions, launch: WorkspaceLauncher = spawn
): ChildProcess {
  const child = launch(command, args, { detached: true, stdio: 'ignore', windowsHide: true, ...options })
  child.on('error', () => onError?.())
  child.unref()
  return child
}

/**
 * Start a launcher and wait just long enough to know it started: false when
 * the process could not spawn (ENOENT) or exited non-zero within the grace
 * window (e.g. `open -a` with a missing app), true once it is still alive
 * after `graceMs`. The grace timer is cleared on the fast path so tests and
 * IPC turnarounds never linger.
 */
function launchSettled(
  command: string, args: string[], graceMs = 2500, options?: SpawnOptions, launch: WorkspaceLauncher = spawn
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok)
    }
    const child = spawnDetached(command, args, () => done(false), options, launch)
    child.once('close', (code) => done(code === 0))
    timer = setTimeout(() => done(true), graceMs)
  })
}

/**
 * Linux has no single "open a terminal here" spell; try the common emulator
 * candidates in order and take the first one that actually launches.
 */
const LINUX_TERMINALS: readonly [string, (dir: string) => string[]][] = [
  ['x-terminal-emulator', (dir) => ['--working-directory', dir]],
  ['gnome-terminal', (dir) => [`--working-directory=${dir}`]],
  ['konsole', (dir) => ['--workdir', dir]],
  ['xfce4-terminal', (dir) => ['--working-directory', dir]]
]

async function openTerminalLinux(dir: string): Promise<boolean> {
  for (const [command, argsOf] of LINUX_TERMINALS) {
    // Short grace: a missing binary reports ENOENT immediately; a real
    // emulator daemonizes and stays alive past the window.
    if (await launchSettled(command, argsOf(dir), 400)) return true
  }
  return false
}

/**
 * Open a Main-resolved workspace directory with the requested app.
 * The realPath must already be canonical (grant-resolved, fsGuard-backed).
 */
export async function openWorkspaceInTarget(
  realPath: string,
  target: OpenWorkspaceTarget
): Promise<OpenWorkspaceResult> {
  if (!isOpenWorkspaceTarget(target)) return { ok: false, reason: 'invalid-target' }
  if (typeof realPath !== 'string' || !realPath.trim()) {
    return { ok: false, reason: 'invalid-workspace' }
  }

  switch (target) {
    case 'finder': {
      // Reveal (not open) so the project shows up selected inside its parent,
      // matching the reveal utilities elsewhere in the app.
      shell.showItemInFolder(realPath)
      return { ok: true }
    }
    case 'terminal': {
      if (process.platform === 'darwin') {
        const ok = await launchSettled('open', ['-a', 'Terminal', realPath])
        return ok ? { ok: true } : { ok: false, reason: 'terminal-missing' }
      }
      if (process.platform === 'win32') {
        const cmd = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
        // START gets a new interactive console. Pass the project as cwd so
        // spaces and shell metacharacters in the directory stay filesystem data.
        const ok = await launchSettled(cmd, ['/D', '/C', 'start "" cmd /D /K'], 400, {
          cwd: realPath, windowsVerbatimArguments: true
        })
        return ok ? { ok: true } : { ok: false, reason: 'terminal-missing' }
      }
      const ok = await openTerminalLinux(realPath)
      return ok ? { ok: true } : { ok: false, reason: 'terminal-missing' }
    }
    case 'editor': {
      if (process.platform === 'darwin') {
        const ok = await launchSettled('open', ['-a', 'Visual Studio Code', realPath])
        return ok ? { ok: true } : { ok: false, reason: 'editor-missing' }
      }
      if (process.platform === 'win32') {
        // VS Code ships a .cmd shim. Reuse our Windows CLI launcher so each
        // argument survives cmd's parsing intact.
        const ok = await launchSettled('code.cmd', [realPath], 2500, undefined, spawnCommand)
        return ok ? { ok: true } : { ok: false, reason: 'editor-missing' }
      }
      const ok = await launchSettled('code', [realPath])
      return ok ? { ok: true } : { ok: false, reason: 'editor-missing' }
    }
  }
}

/**
 * Full IPC contract of workspace:open-in as a pure function: target first
 * (cheap, no authority needed), then grant resolution, then the launcher.
 * The ipc.ts handler binds `resolveGrant` to requireGrant; tests bind a stub.
 */
export async function openWorkspaceInRequest(
  resolveGrant: (id: unknown) => { realPath: string } | null,
  grantId: unknown,
  target: unknown
): Promise<OpenWorkspaceResult> {
  if (!isOpenWorkspaceTarget(target)) return { ok: false, reason: 'invalid-target' }
  const resolved = resolveGrant(grantId)
  if (!resolved) return { ok: false, reason: 'invalid-workspace' }
  return openWorkspaceInTarget(resolved.realPath, target)
}
