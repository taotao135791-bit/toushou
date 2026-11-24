import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/toushou-synthetic-dws' } }))

import { DingTalkCliError } from './DingTalkCli'
import { DingTalkConnectionManager } from './DingTalkConnectionManager'

const tool = { path: '/test/dws', version: '1.0.69', source: 'managed' as const }
const owner = { profile: 'corp-a:alex', organizationName: 'Synthetic agency', accountName: 'Alex' }
const differentAccount = { profile: 'corp-b:pat', organizationName: 'Other company', accountName: 'Pat' }
const fixture = () => ({
  find: vi.fn().mockResolvedValue(tool),
  install: vi.fn().mockResolvedValue(tool),
  status: vi.fn().mockResolvedValue(owner),
  login: vi.fn().mockResolvedValue(owner),
  currentUser: vi.fn().mockResolvedValue({ userId: 'alex' }),
  searchMessages: vi.fn().mockResolvedValue({ messages: ['Synthetic message'] }),
  searchDocuments: vi.fn().mockResolvedValue({ documents: ['Synthetic document'] }),
  readDocument: vi.fn().mockResolvedValue({ markdown: '# Synthetic' })
})

let directory: string
let file: string

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'toushou-dws-manager-'))
  file = path.join(directory, 'link.json')
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('DingTalk account connection', () => {
  it('prepares CLI, opens OAuth and verifies the selected account from one action', async () => {
    const cli = fixture()
    cli.find.mockResolvedValueOnce(null)
    cli.status.mockResolvedValueOnce(null)
    const manager = new DingTalkConnectionManager({ cli, file })
    const observed: string[] = []
    manager.setStatusListener(snapshot => observed.push(snapshot.state))
    expect((await manager.connect()).ok).toBe(true)
    expect(observed).toEqual(['checking', 'installing', 'authorizing', 'checking', 'connected'])
    expect(cli.install).toHaveBeenCalledTimes(1)
    expect(cli.login).toHaveBeenCalledTimes(1)
    expect(cli.currentUser).toHaveBeenCalledWith(tool, owner.profile, expect.any(AbortSignal))
    expect(manager.getSnapshot()).toMatchObject({ configured: true, cliInstalled: true, accountName: 'Alex', organizationName: 'Synthetic agency' })
    expect(manager.getSnapshot()).not.toHaveProperty('profile')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, profile: owner.profile })
  })

  it('reuses an existing CLI authorization and pins tool reads to the chosen worker and organization', async () => {
    const cli = fixture()
    const manager = new DingTalkConnectionManager({ cli, file })
    await manager.initialize()
    expect(cli.login).not.toHaveBeenCalled()
    expect(await manager.connect()).toMatchObject({ ok: true })
    expect(cli.install).not.toHaveBeenCalled()
    expect(cli.login).not.toHaveBeenCalled()
    cli.status.mockResolvedValue(differentAccount)
    expect(await manager.read({ action: 'search_messages', query: '上周预算' })).toEqual({ ok: true, data: { messages: ['Synthetic message'] } })
    expect(cli.searchMessages).toHaveBeenCalledWith(tool, owner.profile, '上周预算', 20, expect.any(AbortSignal))
    expect(await manager.read({ action: 'read_document', documentId: 'n_1234' })).toMatchObject({ ok: true })
    expect(cli.readDocument).toHaveBeenCalledWith(tool, owner.profile, 'n_1234', expect.any(AbortSignal))
    expect(await manager.read({ action: 'read_document', documentId: '../offscope' })).toEqual({ ok: false, error: 'invalid-input' })
  })

  it('restores the same local link on startup and refuses a changed account', async () => {
    await writeFile(file, JSON.stringify({ version: 1, profile: owner.profile }))
    const cli = fixture()
    const manager = new DingTalkConnectionManager({ cli, file })
    await manager.initialize()
    expect(manager.getSnapshot()).toMatchObject({ state: 'connected', accountName: 'Alex' })
    expect(cli.status).toHaveBeenCalledWith(tool, owner.profile, expect.any(AbortSignal))
    cli.status.mockResolvedValue(differentAccount)
    expect(await manager.reconnect()).toMatchObject({ ok: false, error: 'not-authorized' })
    expect(manager.getSnapshot()).toMatchObject({ state: 'error', configured: true, accountName: undefined })
    expect(await manager.read({ action: 'search_messages', query: '预算' })).toEqual({ ok: false, error: 'not-connected' })
    expect(cli.login).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(file, 'utf8')).profile).toBe(owner.profile)
  })

  it('opens browser login after an existing OAuth authorization is revoked', async () => {
    const cli = fixture()
    cli.currentUser.mockRejectedValueOnce(new DingTalkCliError('not-authorized'))
    cli.login.mockResolvedValueOnce(differentAccount)
    const manager = new DingTalkConnectionManager({ cli, file })
    expect(await manager.connect()).toMatchObject({ ok: true, snapshot: { accountName: 'Pat' } })
    expect(cli.login).toHaveBeenCalledTimes(1)
    expect(cli.currentUser).toHaveBeenLastCalledWith(tool, differentAccount.profile, expect.any(AbortSignal))
  })

  it('uses the official login to recover an inconclusive local credential snapshot', async () => {
    const cli = fixture()
    cli.status.mockRejectedValue(new DingTalkCliError('authorization-failed'))
    const manager = new DingTalkConnectionManager({ cli, file })
    expect(await manager.connect()).toMatchObject({ ok: true, snapshot: { state: 'connected' } })
    expect(cli.login).toHaveBeenCalledTimes(1)
  })

  it('keeps organization authorization errors actionable without persisting a link', async () => {
    const cli = fixture()
    cli.currentUser.mockRejectedValue(new DingTalkCliError('organization-access-required'))
    const manager = new DingTalkConnectionManager({ cli, file })
    expect(await manager.connect()).toMatchObject({ ok: false, error: 'organization-access-required', snapshot: { configured: false } })
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the account connected if a document is out of scope for this user', async () => {
    const cli = fixture()
    cli.readDocument.mockRejectedValueOnce(new DingTalkCliError('permission-denied'))
    const manager = new DingTalkConnectionManager({ cli, file })
    await manager.connect()
    expect(await manager.read({ action: 'read_document', documentId: 'private_doc' })).toEqual({ ok: false, error: 'permission-denied' })
    expect(manager.getSnapshot()).toMatchObject({ state: 'connected', accountName: 'Alex' })
    expect(await manager.read({ action: 'search_documents', query: '日报' })).toMatchObject({ ok: true })
    expect(cli.searchDocuments).toHaveBeenCalledWith(tool, owner.profile, '日报', 10, expect.any(AbortSignal))
  })

  it('cancels a pending official login and ignores its late completion', async () => {
    const cli = fixture()
    cli.status.mockResolvedValue(null)
    let authorize!: (value: typeof owner) => void
    cli.login.mockImplementation(() => new Promise(resolve => { authorize = resolve }))
    const manager = new DingTalkConnectionManager({ cli, file })
    const pending = manager.connect()
    await vi.waitFor(() => expect(manager.getSnapshot().state).toBe('authorizing'))
    expect(manager.cancel().snapshot.state).toBe('idle')
    expect(cli.login.mock.calls[0][1].aborted).toBe(true)
    authorize(owner)
    await pending
    expect(manager.getSnapshot()).toMatchObject({ state: 'idle', configured: false })
    expect(cli.currentUser).not.toHaveBeenCalled()
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('disconnects the app and cancels tool reads without clearing the CLI account', async () => {
    const cli = fixture()
    let answer!: (value: unknown) => void
    cli.searchMessages.mockImplementation(() => new Promise(resolve => { answer = resolve }))
    const manager = new DingTalkConnectionManager({ cli, file })
    await manager.connect()
    const query = manager.read({ action: 'search_messages', query: '粤区日报' })
    await vi.waitFor(() => expect(cli.searchMessages).toHaveBeenCalledTimes(1))
    expect(await manager.disconnect()).toMatchObject({ ok: true, snapshot: { state: 'idle', configured: false } })
    answer({ messages: ['Do not deliver after disconnect'] })
    expect(await query).toEqual({ ok: false, error: 'not-connected' })
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await manager.connect()).toMatchObject({ ok: true })
    expect(cli.login).not.toHaveBeenCalled()
  })
})
