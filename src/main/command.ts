import { ChildProcess, SpawnOptions, SpawnSyncReturns } from 'node:child_process'
import { spawn as nativeSpawn, spawnSync as nativeSpawnSync } from 'node:child_process'
import crossSpawn from 'cross-spawn'

function isWindowsCmd(command: string): boolean {
  return process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')
}

/** Spawn a CLI without changing normal platform behavior; cross-spawn handles Windows cmd shims. */
export function spawnCommand(command: string, args: string[], options: SpawnOptions): ChildProcess {
  return isWindowsCmd(command) ? crossSpawn(command, args, options) : nativeSpawn(command, args, options)
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
