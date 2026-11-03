import { createRoot } from 'react-dom/client'
import AdsCopyModelsSection from './AdsCopyModelsSection'
import { useAppStore } from '../store'

type Connection = { baseUrl: string; protocol: 'openai' | 'anthropic'; apiKey: string }
type Input = Connection & { name: string; model: string }
type DiscoveryResult = { ok: boolean; models?: string[] }
type Row = Omit<Input, 'apiKey'> & { id: string; inPool: boolean; createdAt: number }

const fixture = {
  discoveries: [] as Array<{ input: Connection; resolve: (result: DiscoveryResult) => void }>,
  saves: [] as Input[][],
  finishSave: null as ((ok: boolean) => void) | null,
  clipboard: '',
  rows: [{ id: 'existing', name: 'Existing model', baseUrl: 'https://existing.example.test/v1', protocol: 'openai', model: 'existing-model', inPool: true, createdAt: 1 }] as Row[]
}

declare global {
  interface Window { adsCopyFixture: typeof fixture }
}

window.adsCopyFixture = fixture
Object.defineProperty(navigator.clipboard, 'readText', { value: async () => fixture.clipboard })
window.electronAPI = {
  adsCopyModelsList: async () => ({ mode: 'pool', providers: fixture.rows }),
  adsCopyModelsDiscover: (input: Connection) => new Promise<DiscoveryResult>((resolve) => {
    fixture.discoveries.push({ input, resolve })
  }),
  adsCopyModelsAddMany: (inputs: Input[]) => new Promise((resolve) => {
    fixture.saves.push(inputs)
    fixture.finishSave = (ok: boolean) => {
      fixture.finishSave = null
      if (!ok) { resolve({ ok: false, error: 'save-failed' }); return }
      let added = 0
      for (const input of inputs) {
        if (fixture.rows.some(row => row.baseUrl === input.baseUrl && row.protocol === input.protocol && row.model === input.model)) continue
        const { apiKey: _key, ...row } = input
        fixture.rows.push({ ...row, id: `added-${fixture.rows.length}`, inPool: false, createdAt: 2 })
        added += 1
      }
      resolve({ ok: true, added, skipped: inputs.length - added, limitReached: false })
    }
  })
} as unknown as typeof window.electronAPI
useAppStore.setState({ language: 'en' })
createRoot(document.getElementById('root')!).render(<AdsCopyModelsSection />)
