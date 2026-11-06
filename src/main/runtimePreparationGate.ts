// Kept independent of the runtime and package modules: both session spawning
// and package installation need this state without an import cycle.
const preparations = new Set<symbol>()

export function beginRuntimePreparation(): () => void {
  const token = Symbol('runtime-preparation')
  preparations.add(token)
  return () => { preparations.delete(token) }
}

export function isRuntimePreparing(): boolean {
  return preparations.size > 0
}
