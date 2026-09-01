import { ChildProcess, SpawnOptions, SpawnSyncReturns } from 'node:child_process'
import { spawn as nativeSpawn, spawnSync as nativeSpawnSync } from 'node:child_process'
import crossSpawn from 'cross-spawn'

function isWindowsCmd(command: string): boolean {
  return process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')
}

/** npm `.cmd` shims create a cmd.exe parent; terminate its whole tree on close. */
function withWindowsTreeKill(child: ChildProcess): ChildProcess {
  const kill = child.kill.bind(child)
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (child.pid && process.platform === 'win32') {
      try {
        nativeSpawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
        return true
      } catch {
        // Fall back to the normal kill if taskkill is unavailable or the process is gone.
      }
    }
    return kill(signal)
  }) as ChildProcess['kill']
  return child
}

/** Spawn a CLI without changing normal platform behavior; cross-spawn handles Windows cmd shims. */
export function spawnCommand(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (!isWindowsCmd(command)) return nativeSpawn(command, args, options)
  return withWindowsTreeKill(crossSpawn(command, args, options))
}

/** Synchronous companion used by isolated compatibility tests. */
export function spawnCommandSync(
  command: string,
  args: string[],
  options: Parameters<typeof nativeSpawnSync>[2]
): SpawnSyncReturns<string | Buffer> {
  return isWindowsCmd(command)
    ? crossSpawn.sync(command, args, options)
    : nativeSpawnSync(command, args, options)
}
