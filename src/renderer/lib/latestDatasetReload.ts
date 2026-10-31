/** Shared generation state also lets the initial page load invalidate a reload. */
export interface DatasetReloadState { generation: number; latest: { generation: number; promise: Promise<boolean> } | null }

/** Follow newer reloads rather than reporting a discarded response as an I/O error. */
export function reloadLatestDataset<T>(
  state: DatasetReloadState,
  read: () => Promise<T>,
  accept: (value: T) => void,
  fail: () => void,
  attempt = 0
): Promise<boolean> {
  const generation = ++state.generation
  const task = (async () => {
    let result: { ok: true; value: T } | { ok: false }
    try { result = { ok: true, value: await read() } } catch { result = { ok: false } }
    if (generation !== state.generation) {
      const newer = state.latest
      if (newer && newer.generation > generation) return newer.promise
      return attempt < 3 ? reloadLatestDataset(state, read, accept, fail, attempt + 1) : false
    }
    if (!result.ok) { fail(); return false }
    accept(result.value)
    return true
  })()
  state.latest = { generation, promise: task }
  return task
}
