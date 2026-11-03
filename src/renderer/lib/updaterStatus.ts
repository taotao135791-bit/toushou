import type { UpdaterStatus } from '@shared/types'

type UpdaterStatusApi = Pick<Window['electronAPI'], 'updaterGetStatus' | 'onUpdaterStatus'>

/** Subscribe first: an older initial snapshot must never replace a live event. */
export function subscribeUpdaterStatus(onStatus: (status: UpdaterStatus) => void, api: UpdaterStatusApi = window.electronAPI): () => void {
  let active = true
  let receivedEvent = false
  const unsubscribe = api.onUpdaterStatus(status => {
    if (!active) return
    receivedEvent = true
    onStatus(status)
  })
  void api.updaterGetStatus().then(status => {
    if (active && !receivedEvent) onStatus(status)
  }).catch(() => undefined)
  return () => { active = false; unsubscribe() }
}
