import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UpdaterStatus } from '@shared/types'
import UpdateBanner from './UpdateBanner'
import { useAppStore } from '../store'

const fixture = {
  status: { status: 'idle' } as UpdaterStatus,
  listener: null as ((status: UpdaterStatus) => void) | null,
  initial: null as ((status: UpdaterStatus) => void) | null,
  downloads: 0,
  installs: 0,
  snapshots: 0,
  emit(status: UpdaterStatus) { fixture.status = status; fixture.listener?.(status) }
}
declare global { interface Window { updateFixture: typeof fixture } }
window.updateFixture = fixture
window.electronAPI = {
  updaterGetStatus: () => ++fixture.snapshots === 1 ? new Promise<UpdaterStatus>(resolve => { fixture.initial = resolve }) : Promise.resolve(fixture.status),
  onUpdaterStatus: (callback: (status: UpdaterStatus) => void) => { fixture.listener = callback; return () => { fixture.listener = null } },
  updaterDownload: async () => { fixture.downloads += 1; fixture.emit({ status: 'downloading' }); return fixture.status },
  updaterQuitAndInstall: async () => { fixture.installs += 1 },
  updaterCheck: async () => fixture.status,
  updaterOpenReleasePage: async () => undefined
} as unknown as typeof window.electronAPI
useAppStore.setState({ language: 'en' })
function Fixture() {
  const [generation, setGeneration] = useState(0)
  return <><button id="remount" onClick={() => setGeneration(value => value + 1)}>remount</button><div id="banner"><UpdateBanner key={generation} /></div></>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
