import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DingTalkCli, DingTalkCliError, type DingTalkCliInstallation } from './DingTalkCli'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const tempDirectories: string[] = []
afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dingtalk-cli-'))
  tempDirectories.push(directory)
  return directory
}

type Options = NonNullable<ConstructorParameters<typeof DingTalkCli>[0]>
type Run = NonNullable<Options['run']>

const processOutput = (data: unknown, exitCode = 0) => ({ exitCode, stdout: JSON.stringify(data), stderr: '' })
const cli: DingTalkCliInstallation = { path: path.resolve('dws-fixture'), version: 'v1.0.69', source: 'managed' }
const profile = 'ding_fixture:staff_fixture'

describe('DingTalk CLI', () => {
  it('reads the account from the official OAuth JSON response and calls only fixed login arguments', async () => {
    const run = vi.fn<Run>().mockResolvedValue(processOutput({
      success: true, corp_id: 'ding_fixture', user_id: 'staff_fixture',
      corp_name: '团队\u202e名称', user_name: '员工\n甲', token_valid: true,
      access_token: 'synthetic-extra-field'
    }))
    const dws = new DingTalkCli({ run })
    await expect(dws.login(cli)).resolves.toEqual({ profile, accountName: '员工甲', organizationName: '团队名称' })
    expect(run).toHaveBeenCalledWith(cli.path, ['auth', 'login', '--format=json'], path.dirname(cli.path), 300_000, undefined)
  })

  it('does not follow the terminal default account when verifying a pinned identity', async () => {
    const run = vi.fn<Run>().mockResolvedValue(processOutput({
      success: true, authenticated: true, corp_id: 'ding_other', user_id: 'staff_other'
    }))
    const dws = new DingTalkCli({ run })
    await expect(dws.status(cli, profile)).rejects.toMatchObject({ code: 'not-authorized' })
    expect(run.mock.calls[0]?.[1]).toEqual(['auth', 'status', '--readonly', '--format=json', '--profile=' + profile])
    run.mockResolvedValue(processOutput({ success: true, authenticated: false, reason: 'local_state_unreadable' }))
    await expect(dws.status(cli, profile)).rejects.toMatchObject({ code: 'authorization-failed' })
    run.mockResolvedValue(processOutput({ success: true, authenticated: false }))
    await expect(dws.status(cli, profile)).resolves.toBeNull()
  })

  it('uses bounded read commands with the explicit profile and preserves query text as one option value', async () => {
    const run = vi.fn<Run>().mockResolvedValue(processOutput({ success: true, data: [] }))
    const dws = new DingTalkCli({ run })
    const fixed = '--profile=' + profile
    const tail = ['--format=json', '--timeout=25']
    await dws.currentUser(cli, profile)
    await dws.searchMessages(cli, profile, '--yes & 陈列广告', 100)
    await dws.searchDocuments(cli, profile, '预算', 12)
    await dws.readDocument(cli, profile, 'readable_abc-1')
    expect(run.mock.calls.map(([, args]) => args)).toEqual([
      [fixed, 'contact', 'user', 'get-self', ...tail],
      [fixed, 'chat', '+search-msg', '--query=--yes & 陈列广告', '--limit=20', '--no-enrich', ...tail],
      [fixed, 'drive', 'search', '--query=预算', '--target=file', '--extensions=adoc', '--limit=10', ...tail],
      [fixed, 'doc', 'read', '--node=readable_abc-1', ...tail]
    ])
    await expect(dws.currentUser(cli, 'ding_fixture:staff_fixture,other:me')).rejects.toMatchObject({ code: 'not-authorized' })
    expect(() => dws.readDocument(cli, profile, 'https://example.test/a')).toThrow(DingTalkCliError)
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('projects authorization errors to safe codes without exposing service messages', async () => {
    const run = vi.fn<Run>().mockResolvedValue(processOutput({ error: { message: '组织尚未开通 CLI：synthetic-secret' } }, 1))
    await expect(new DingTalkCli({ run }).login(cli)).rejects.toMatchObject({
      code: 'organization-access-required', message: 'organization-access-required'
    })
  })

  it('distinguishes a document permission denial from expired account authorization', async () => {
    const run = vi.fn<Run>()
      .mockResolvedValueOnce(processOutput({ success: false, message: '无权访问这份文档' }))
      .mockResolvedValueOnce(processOutput({ error: { reason: 'AUTH_REQUIRED' } }, 1))
    const dws = new DingTalkCli({ run })
    await expect(dws.readDocument(cli, profile, 'doc1')).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(dws.readDocument(cli, profile, 'doc1')).rejects.toMatchObject({ code: 'not-authorized' })
  })

  it('detects a compatible DWS executable from the standard directories without writing to it', async () => {
    const directory = await tempDirectory()
    const name = process.platform === 'win32' ? 'dws.exe' : 'dws'
    const executable = path.join(directory, name)
    const run = vi.fn<Run>().mockResolvedValue({ exitCode: 0, stdout: 'dws version v1.0.69 (synthetic)\n', stderr: '' })
    await writeFile(executable, 'placeholder', { mode: 0o700 })
    const dws = new DingTalkCli({ directory: path.join(directory, 'managed-directory'), searchDirectories: () => [directory], run })
    await expect(dws.find()).resolves.toEqual({ path: executable, version: 'v1.0.69', source: 'external' })
    expect(run).toHaveBeenCalledWith(executable, ['--version'], directory, 8_000, undefined)
    expect(await readdir(directory)).toEqual([name])
  })

  it('does not execute data from an unrecognized redirect or an unverified archive', async () => {
    const directory = await tempDirectory()
    const run = vi.fn<Run>()
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://example.test/redirect' } }))
      .mockResolvedValueOnce(new Response('a corrupt archive'))
    const dws = new DingTalkCli({ directory, request, run })
    await expect(dws.install()).rejects.toMatchObject({ code: 'install-failed' })
    expect(request.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['github.com', 'gitee.com'])
    expect(run).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })

  it('tries the official mirror if the primary host does not return headers promptly', async () => {
    const directory = await tempDirectory()
    const run = vi.fn<Run>()
    let started!: () => void
    const primaryStarted = new Promise<void>(resolve => { started = resolve })
    const request = vi.fn<typeof fetch>()
      .mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('headers timeout')), { once: true })
        started()
      }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
    vi.useFakeTimers()
    try {
      const dws = new DingTalkCli({ directory, request, run })
      const failed = expect(dws.install()).rejects.toMatchObject({ code: 'network' })
      await primaryStarted
      await vi.advanceTimersByTimeAsync(12_000)
      await failed
      expect(request.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['github.com', 'gitee.com'])
      expect(run).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does no work after local cancellation', async () => {
    const run = vi.fn<Run>()
    const dws = new DingTalkCli({ run })
    const cancellation = AbortSignal.abort()
    await expect(dws.install(cancellation)).rejects.toMatchObject({ code: 'cancelled' })
    await expect(dws.login(cli, cancellation)).rejects.toMatchObject({ code: 'cancelled' })
    expect(run).not.toHaveBeenCalled()
  })
})
