import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DingTalkCli, DingTalkCliError, type DingTalkCliInstallation } from './DingTalkCli'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
const chooseTransfer = vi.hoisted(() => vi.fn())
vi.mock('./workspaceFileTransfer', () => ({ withDingTalkTransfer: chooseTransfer }))

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
  it('runs reviewed workspace commands with bound identity and literal named flags, without a shell or stdin input', async () => {
    const run = vi.fn<Run>().mockResolvedValue(processOutput({ ok: true, data: { values: [[42]], access_token: 'synthetic-secret' } }))
    const dws = new DingTalkCli({ run })
    await expect(dws.workspaceOperation(cli, profile, 'sheet.range.read', { node: 'node123', range: 'A1:B1' })).resolves.toEqual({ ok: true, data: { values: [[42]] } })
    const [file, argv, cwd, time, signal, input] = run.mock.calls[0]
    expect(file).toBe(cli.path)
    expect(argv.slice(0, 4)).toEqual(['--profile=' + profile, 'sheet', 'range', 'read'])
    expect(argv).toEqual(expect.arrayContaining(['--node=node123', '--range=A1:B1', '--format=json', '--timeout=25']))
    expect([cwd, time, signal, input]).toEqual([path.dirname(cli.path), 35_000, undefined, undefined])
    await expect(dws.workspaceOperation(cli, 'wrong,other', 'sheet.range.read', { node: 'n' })).rejects.toMatchObject({ code: 'not-authorized' })
    await expect(dws.workspaceOperation(cli, profile, 'mcp.call', {})).rejects.toBeInstanceOf(DingTalkCliError)
    await expect(dws.workspaceOperation(cli, profile, 'sheet.range.read', { node: '@priv', profile })).rejects.toBeInstanceOf(DingTalkCliError)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('uses explicit workspace write receipts and never replays a missing or partially completed write', async () => {
    const args = { node: 'n', 'sheet-id': 's', range: 'A1:B1', values: [['量', 42]] }
    const run = vi.fn<Run>()
    const dws = new DingTalkCli({ run })
    const update = (signal?: AbortSignal) => dws.workspaceOperation(cli, profile, 'sheet.range.update', args, signal)
    run.mockResolvedValueOnce(processOutput({ success: true }))
    await expect(update()).resolves.toEqual({ success: true })
    expect(run.mock.calls[0][1]).toContain('--values=' + JSON.stringify([[{ type: 'text', text: '量' }, { type: 'text', text: '42' }]]))
    for (const receipt of [{}, { ok: true, outcome: 'pending' }, { ok: true, outcome: 'partial_failure' },
      { success: true, data: { executed: false } }, { success: true, status: 'partial' }, { success: true, dry_run: true },
      { success: true, result: { failedCount: 2 } }, { success: true, steps: [{ status: 'failed' }] }]) {
      run.mockResolvedValueOnce(processOutput(receipt))
      await expect(update()).rejects.toMatchObject({ code: 'write-outcome-unknown' })
    }
    run.mockResolvedValueOnce(processOutput({ error: { execution_started: false, reason: 'PERMISSION_DENIED' } }, 1))
    await expect(update()).rejects.toMatchObject({ code: 'permission-denied' })
    run.mockRejectedValueOnce(new Error('synthetic private response'))
    await expect(update()).rejects.toMatchObject({ code: 'write-outcome-unknown', message: 'write-outcome-unknown' })
    await expect(update(AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled' })
    const controller = new AbortController()
    run.mockImplementationOnce(async () => { controller.abort(); return processOutput({ success: true }) })
    await expect(update(controller.signal)).rejects.toMatchObject({ code: 'write-outcome-unknown' })
    expect(run).toHaveBeenCalledTimes(12)
  })

  it('selects the audited CLI for workspace operations while preserving an existing compatible installation for legacy calls', async () => {
    const run = vi.fn<Run>().mockResolvedValue(processOutput({ success: true }))
    const dws = new DingTalkCli({ run })
    const find = vi.spyOn(dws, 'find').mockResolvedValue(null)
    const install = vi.spyOn(dws, 'install').mockResolvedValue(cli)
    const newer = { ...cli, path: cli.path + '-new', version: 'v1.1.0' }
    await dws.searchDocuments(newer, profile, '示例', 2)
    expect(find).not.toHaveBeenCalled()
    expect(run.mock.calls[0][0]).toBe(newer.path)
    await dws.workspaceOperation(newer, profile, 'sheet.range.read', { node: 'n' })
    expect(find).toHaveBeenCalledWith(undefined, 'v1.0.69')
    expect(install).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[1][0]).toBe(cli.path)
  })

  it('takes a transfer path only from the native picker and checks write permission again when the picker returns', async () => {
    const run = vi.fn<Run>().mockResolvedValue(processOutput({ success: true, savedPath: '/synthetic/private-location' }))
    const dws = new DingTalkCli({ run })
    let permitted = true
    const download = () => dws.workspaceOperation(cli, profile, 'drive.download', { node: 'node-42' }, undefined, () => permitted)
    chooseTransfer.mockImplementationOnce(async (_id, _flag, _signal, dispatch) => {
      permitted = false
      return dispatch('/synthetic/private-location')
    })
    await expect(download()).rejects.toMatchObject({ code: 'permission-denied' })
    expect(run).not.toHaveBeenCalled()
    permitted = true
    chooseTransfer.mockImplementationOnce((_id, _flag, _signal, dispatch) => dispatch('/synthetic/private-location'))
    await expect(download()).resolves.toEqual({ saved: true })
    expect(run.mock.calls[0][1]).toContain('--output=/synthetic/private-location')
    await expect(dws.workspaceOperation(cli, profile, 'drive.download', { node: 'n', output: '/other' })).rejects.toBeInstanceOf(DingTalkCliError)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('uses repeatable Cobra flags and recognizes each audited legacy receipt without exposing local staging paths', async () => {
    const run = vi.fn<Run>()
    const dws = new DingTalkCli({ run })
    run.mockResolvedValueOnce(processOutput({ items: [] }))
    await dws.workspaceOperation(cli, profile, 'drive.search', { query: '月报', extensions: ['adoc', 'pdf'] })
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(['--extensions=adoc', '--extensions=pdf']))

    run.mockResolvedValueOnce(processOutput({}))
    await expect(dws.workspaceOperation(cli, profile, 'doc.permission.update', { node: 'n', users: 'u', role: 'viewer' })).resolves.toEqual({ success: true })
    expect(run.mock.calls[1][1]).toEqual(expect.arrayContaining(['--notify=false', '--yes=true']))

    const staging = '/synthetic/private-location'
    chooseTransfer.mockImplementation((_id, _flag, _signal, dispatch) => dispatch(staging))
    run.mockResolvedValueOnce(processOutput({ contractVersion: 'doc.operation.v1', ok: true, status: 'success', complete: true,
      data: { verified: true, name: 'example', savedPath: staging, info: 'saved ' + staging } }))
    const uploaded = await dws.workspaceOperation(cli, profile, 'doc.media.insert', { node: 'n' })
    expect(uploaded).toMatchObject({ data: { verified: true, name: 'example' } })
    expect(JSON.stringify(uploaded)).not.toContain(staging)
    run.mockResolvedValueOnce({ exitCode: 0, stdout: '附件已保存到: ' + staging, stderr: '' })
    await expect(dws.workspaceOperation(cli, profile, 'mail.attachment.download', { 'attachment-id': 'a', email: 'demo@example.org', 'message-id': 'm' })).resolves.toEqual({ saved: true })
    expect(run.mock.calls[3][1]).toContain('--name=attachment.bin')
    run.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '导出完成' })
    await expect(dws.workspaceOperation(cli, profile, 'sheet.export-csv', { node: 'n' })).resolves.toEqual({ saved: true })
    run.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
    await expect(dws.workspaceOperation(cli, profile, 'drive.upload', {})).rejects.toMatchObject({ code: 'write-outcome-unknown' })
    chooseTransfer.mockReset()
  })

  it('overwrites only the confirmed document, with Markdown on stdin and a verified overwrite readback', async () => {
    const run = vi.fn<Run>()
    const dws = new DingTalkCli({ run })
    const args = { node: 'https://alidocs.dingtalk.com/i/nodes/fixtureNode', content: '@file.md\n\n# 正文\n' + '新'.repeat(26_000) }
    const update = (input = args) => dws.workspaceOperation(cli, profile, 'doc.update', input, undefined, () => true)
    const data = { nodeId: 'fixtureNode', mode: 'overwrite', verified: true }
    const receipt = { contractVersion: 'doc.operation.v1', status: 'success', complete: true, ok: true, operation: 'doc.update', data }
    run.mockResolvedValueOnce(processOutput(receipt))
    await expect(update()).resolves.toEqual({ nodeId: 'fixtureNode', url: args.node })
    const argv = run.mock.calls[0][1]
    expect(argv).toEqual(expect.arrayContaining(['doc', '+update', '--node=fixtureNode', '--content=-', '--command=overwrite', '--yes=true']))
    expect(argv.join(' ')).not.toContain('正文')
    expect(run.mock.calls[0][5]).toEqual({ input: args.content })
    run.mockResolvedValueOnce(processOutput({ ...receipt, data: { ...data, mode: 'append' } }))
    await expect(update()).rejects.toMatchObject({ code: 'write-outcome-unknown', nodeId: 'fixtureNode' })
    run.mockResolvedValueOnce(processOutput({ ...receipt, data: { ...data, executed: false } }))
    await expect(update()).rejects.toMatchObject({ code: 'write-outcome-unknown' })
    await expect(update({ ...args, node: 'https://example.com/doc' })).rejects.toMatchObject({ code: 'write-failed' })
    expect(run).toHaveBeenCalledTimes(3)
  })

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

  it('classifies a rejected MCP grant as a request to reauthorize the existing profile', async () => {
    const run = vi.fn<Run>()
    const dws = new DingTalkCli({ run })
    for (const detail of ['invalidParameter.authCode.notFound', 'providerError - 不合法的临时授权码']) {
      run.mockResolvedValueOnce({
        exitCode: 5, stdout: '', stderr: JSON.stringify({
          error: { category: 'internal', code: 5, message: `MCP token exchange failed: ${detail}` }
        })
      })
      await expect(dws.currentUser(cli, profile)).rejects.toMatchObject({
        code: 'profile-reauthorization-required', message: 'profile-reauthorization-required'
      })
    }
    run.mockResolvedValueOnce({
      exitCode: 5, stdout: '', stderr: JSON.stringify({ error: { message: 'MCP token exchange failed: internal service error' } })
    })
    await expect(dws.currentUser(cli, profile)).rejects.toMatchObject({ code: 'read-failed' })
  })

  it('passes the exact profile to the official login and rejects a different returned identity', async () => {
    const run = vi.fn<Run>().mockResolvedValue(processOutput({ success: true, corp_id: 'ding_fixture', user_id: 'staff_fixture' }))
    const dws = new DingTalkCli({ run })
    await expect(dws.login(cli, undefined, profile)).resolves.toMatchObject({ profile })
    expect(run.mock.calls[0][1]).toEqual(['auth', 'login', '--format=json', '--profile=' + profile])
    run.mockResolvedValueOnce(processOutput({ success: true, corp_id: 'ding_fixture', user_id: 'staff_other' }))
    await expect(dws.login(cli, undefined, profile)).rejects.toMatchObject({ code: 'not-authorized' })
    await expect(dws.login(cli, undefined, '--profile=other')).rejects.toMatchObject({ code: 'not-authorized' })
    expect(run).toHaveBeenCalledTimes(2)
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

  it('creates blank and populated documents and appends only to the bound node, with Markdown on stdin', async () => {
    const receipt = (operation: string, data: Record<string, unknown>) => processOutput({
      contractVersion: 'doc.operation.v1', operation, ok: true, complete: true, status: 'success',
      data: { nodeId: 'node123', verified: true, ...data }
    })
    const run = vi.fn<Run>()
      .mockResolvedValueOnce(receipt('doc.create', { result: { ignored: 'extra' } }))
      .mockResolvedValueOnce(receipt('doc.create', {}))
      .mockResolvedValueOnce(receipt('doc.update', { mode: 'append' }))
    const dws = new DingTalkCli({ run })
    const content = '@fixture.md\n\n# 进度\n--command=overwrite'
    const result = { nodeId: 'node123' }
    await expect(dws.createDocument(cli, profile, '--workspace=literal', content, 'folder123')).resolves.toEqual(result)
    await expect(dws.createDocument(cli, profile, '空白')).resolves.toEqual(result)
    await expect(dws.appendDocument(cli, profile, 'node123', content)).resolves.toEqual(result)
    const tail = ['--format=json', '--timeout=30']
    const start = ['--profile=' + profile, 'doc']
    expect(run.mock.calls.map(([, args, , , , io]) => [args, io])).toEqual([
      [[...start, '+create', '--name=--workspace=literal', '--folder=folder123', '--content=-', ...tail], { input: content }],
      [[...start, '+create', '--name=空白', ...tail], { input: '' }],
      [[...start, '+update', '--node=node123', '--command=append', '--content=-', '--yes', ...tail], { input: content }]
    ])
  })

  it('validates write inputs before dispatch and distinguishes cancellation before dispatch', async () => {
    const run = vi.fn<Run>()
    const dws = new DingTalkCli({ run })
    await expect(dws.createDocument(cli, profile, '\n')).rejects.toMatchObject({ code: 'write-failed' })
    await expect(dws.createDocument(cli, profile, '新建', '', '../fixture')).rejects.toMatchObject({ code: 'write-failed' })
    await expect(dws.appendDocument(cli, profile, 'node123', '\0bad')).rejects.toMatchObject({ code: 'write-failed' })
    await expect(dws.appendDocument(cli, profile, 'node123', 'x'.repeat(64_001))).rejects.toMatchObject({ code: 'write-failed' })
    await expect(dws.appendDocument(cli, 'corp:one,corp:two', 'node123', 'x')).rejects.toMatchObject({ code: 'not-authorized' })
    await expect(dws.createDocument(cli, profile, '标题', undefined, undefined, AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled' })
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps partial, interrupted, malformed and unverified writes uncertain without replaying them', async () => {
    // The pinned dws writes error JSON to stderr, including node IDs for partially committed creates.
    const partial = { error: { execution_started: true, details: { status: 'partial_success', data: { nodeId: 'known123' } } } }
    const base = { contractVersion: 'doc.operation.v1', operation: 'doc.update', ok: true, complete: true, status: 'success' }
    const run = vi.fn<Run>()
      .mockResolvedValueOnce({ exitCode: 4, stdout: '', stderr: JSON.stringify(partial) })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'truncated', stderr: '' })
      .mockResolvedValueOnce(processOutput({ ...base, data: { nodeId: 'other', mode: 'append', verified: true } }))
      .mockResolvedValueOnce(processOutput({ ...base, data: { nodeId: 'n', command: 'append', executed: false } }))
      .mockResolvedValueOnce(processOutput({ ...base, data: { nodeId: 'n', mode: 'append', verified: false } }))
      .mockRejectedValueOnce(new DingTalkCliError('network'))
      .mockRejectedValueOnce(new DingTalkCliError('cancelled'))
    const dws = new DingTalkCli({ run })
    await expect(dws.createDocument(cli, profile, '报告')).rejects.toMatchObject({ code: 'write-outcome-unknown', nodeId: 'known123' })
    for (let i = 0; i < 6; i++) {
      await expect(dws.appendDocument(cli, profile, 'n', '正文')).rejects.toMatchObject({ code: 'write-outcome-unknown', nodeId: 'n' })
    }
    expect(run).toHaveBeenCalledTimes(7)
  })

  it('reports confirmed rejections without exposing upstream text or confusing a failed readback with a permission denial', async () => {
    const run = vi.fn<Run>()
      .mockResolvedValueOnce(processOutput({ error: { category: 'validation', message: 'synthetic' } }, 3))
      .mockResolvedValueOnce(processOutput({ error: { reason: 'permission_denied', execution_started: false } }, 1))
      .mockResolvedValueOnce(processOutput({ error: { category: 'auth', reason: 'authentication_required' } }, 1))
      .mockResolvedValueOnce(processOutput({ error: { reason: 'permission_denied', details: { status: 'partial_success', data: { nodeId: 'https://untrusted.invalid/' } } } }, 1))
    const dws = new DingTalkCli({ run })
    for (const code of ['write-failed', 'permission-denied', 'not-authorized', 'write-outcome-unknown']) {
      await expect(dws.createDocument(cli, profile, '测试')).rejects.toMatchObject({ code, message: code, nodeId: undefined })
    }
  })

  it('accepts the official content readback when only the identity of a mention cannot be verified', async () => {
    const run = vi.fn<Run>().mockResolvedValue(processOutput({
      contractVersion: 'doc.operation.v1', operation: 'doc.create', ok: true, status: 'success', complete: true,
      data: { nodeId: 'new123', verified: false, verificationScope: 'partial', unverified: ['mention_targets'] }
    }))
    await expect(new DingTalkCli({ run }).createDocument(cli, profile, '正文')).resolves.toEqual({
      nodeId: 'new123', mentionTargetsUnverified: true
    })
  })

  it('delivers multiline UTF-8 through the real subprocess stdin including EOF', async () => {
    const directory = await tempDirectory()
    const scriptPath = path.join(directory, 'fixture.cjs')
    const executable = process.platform === 'win32' ? path.join(directory, 'dws.cmd') : scriptPath
    const content = '@local-fixture.md\n\n# 正文\n' + 'π'.repeat(20_000)
    const script = [
      '#!/usr/bin/env node',
      "const input = require('node:fs').readFileSync(0, 'utf8')",
      "const valid = input.startsWith('@local-fixture.md\\n\\n# 正文\\n') && input.endsWith('π'.repeat(20000))",
      "if (!valid || !process.argv.includes('--content=-')) process.exit(1)",
      "console.log(JSON.stringify({ contractVersion: 'doc.operation.v1', operation: 'doc.create', ok: true, status: 'success', complete: true, data: { nodeId: 'offline123', verified: true } }))"
    ].join('\n')
    await writeFile(scriptPath, script, { mode: 0o700 })
    if (process.platform === 'win32') {
      await writeFile(executable, `@"${process.execPath}" "%~dp0fixture.cjs" %*\r\n`)
    }
    await expect(new DingTalkCli().createDocument({ ...cli, path: executable }, profile, '报告', content)).resolves.toEqual({ nodeId: 'offline123' })
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
