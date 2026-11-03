import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { TodayReading } from './TodayReading'
import { useAppStore } from '../../store'
import type { FbReadingHistoryEntry } from '@shared/fbReading'

const accounts = ['123456', '234567', '345678'].map((act, i) => ({ id: act, act, alias: ['Fixture Alpha', 'Fixture Beta', 'Fixture Gamma'][i], businessId: null, createdAt: 1 }))
const history: Record<string, FbReadingHistoryEntry[]> = {}
const state = { calls: [] as Array<{ act: string; startDate: string; endDate: string }>, fail: '', failType: 'date-mismatch', hold: false, release: null as (() => void) | null, snapshot: null as unknown }
Object.assign(window, { fbFixture: state })
window.electronAPI = {
  listFbReadingAccounts: async () => accounts,
  listFbReadings: async ({ accountId }: { accountId: string }) => history[accountId] ?? [],
  refreshFbReading: async (input: { act: string; startDate: string; endDate: string }) => {
    state.calls.push(input)
    if (state.hold) await new Promise<void>(resolve => { state.release = resolve })
    if (input.act === state.fail) return { ok: false, error: state.failType }
    const entry = { id: 'reading', accountId: input.act, accountName: input.act, dateRangeLabel: `${input.startDate.replace(/(\d+)-(\d+)-(\d+)/, '$1年$2月$3日')} – ${input.endDate.replace(/(\d+)-(\d+)-(\d+)/, '$1年$2月$3日')}`, campaignCount: 1, totalSpend: 25, capturedAt: new Date().toISOString(), rows: [{ name: 'Campaign', spend: 25, impressions: 100, clicks: 10, results: 2, resultType: 'app_install', costPerResult: 12.5, cpm: null, ctr: null, cpc: null, installs: null }] }
    history[input.act] = [entry]
    return { ok: true, entry }
  },
  ttReadingAdvertisers: async () => ({ selected: [], granted: [], accounts: [] }),
  listBoards: async () => [],
  saveReadingSnapshot: async (input: { snapshot: unknown }) => { state.snapshot = input.snapshot; return { ok: false, error: 'write-failed' } },
  setStoreValue: async () => undefined
} as unknown as Window['electronAPI']
useAppStore.setState({ language: 'zh', workspacePanel: { kind: 'browser' } })
createRoot(document.getElementById('root')!).render(<MemoryRouter><TodayReading /></MemoryRouter>)
