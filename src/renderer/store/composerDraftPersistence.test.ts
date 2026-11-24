import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerDraftChanges, ComposerDrafts, Session } from '@shared/types'

let storeModule: typeof import('./index')
const textDraft = (text: string) => ({ text, images: [] })
const save = vi.fn<(changes: ComposerDraftChanges) => Promise<boolean>>()
const load = vi.fn<() => Promise<ComposerDrafts>>()
const session = (id: string, uuid?: string): Session => ({
  id, draftSessionUuid: uuid, cwd: '/fixture', title: 'Conversation', createdAt: 1, status: 'idle'
})

beforeEach(async () => {
  vi.resetModules()
  save.mockReset().mockResolvedValue(true)
  load.mockReset().mockResolvedValue({})
  vi.stubGlobal('window', { electronAPI: { setComposerDrafts: save, getComposerDrafts: load } })
  storeModule = await import('./index')
})

afterEach(async () => {
  await storeModule.flushComposerDrafts()
  vi.unstubAllGlobals()
})

describe('composer draft store persistence', () => {
  it('keeps changes and explicit deletes made during slow startup', async () => {
    let completeRead!: (drafts: ComposerDrafts) => void
    load.mockImplementationOnce(() => new Promise(resolve => { completeRead = resolve }))
    const { useAppStore, flushComposerDrafts } = storeModule
    const store = useAppStore.getState()
    const hydration = store.hydrateComposerDrafts()
    store.clearComposerDraft('__new-chat__')
    store.setComposerDraft('edited-session', textDraft('new local text'))
    completeRead({ '__new-chat__': textDraft('sent already'), 'edited-session': textDraft('old'), 'unrelated-session': textDraft('keep') })
    await hydration
    expect(useAppStore.getState().composerDrafts).toEqual({ 'edited-session': textDraft('new local text'), 'unrelated-session': textDraft('keep') })
    await flushComposerDrafts()
    expect(save.mock.calls).toEqual([[{ '__new-chat__': null, 'edited-session': textDraft('new local text') }]])
  })

  it('migrates existing drafts as durable IDs arrive and keeps them after a runtime closes', async () => {
    const { useAppStore, flushComposerDrafts } = storeModule
    useAppStore.setState({ sessions: [session('runtime-A')] })
    const store = useAppStore.getState()
    store.setComposerDraft('runtime-A', textDraft('resume this draft'))
    store.setSessionFile('runtime-A', '/fixture/durable.jsonl', 'durable-id')
    store.setSessions([])
    expect(useAppStore.getState().composerDrafts).toEqual({ 'history:durable-id': textDraft('resume this draft') })
    await flushComposerDrafts()
    expect(save.mock.calls).toEqual([[{ 'runtime-A': null, 'history:durable-id': textDraft('resume this draft') }]])
    useAppStore.setState({ sessions: [session('runtime-B', 'durable-id')] })
    store.clearComposerDraft('runtime-B')
    expect(useAppStore.getState().composerDrafts).toEqual({})
  })
})
