const { test } = require('node:test')
const { execFileSync, spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { checkBuilds, guardHistory, plan, resolveSource, platforms, payloadNames, verifyFiles } = require('../tools/release-verify.cjs')

const version = '2.9.9'
const sha = (name, bytes) => createHash(name).update(bytes).digest(name === 'sha512' ? 'base64' : 'hex')

function stage(directory, platform, edit = () => {}) {
  const names = payloadNames(platform)
  const manifest = names.find(name => name.endsWith('.yml'))
  const files = names.filter(name => /\.(dmg|zip|exe)$/.test(name)).map(url => {
    const payload = Buffer.from('example ' + url)
    writeFileSync(join(directory, url), payload)
    return { url, size: payload.length, sha512: sha('sha512', payload) }
  })
  const metadata = { version, files, path: files[0].url, sha512: files[0].sha512 }
  edit(metadata)
  writeFileSync(join(directory, manifest), JSON.stringify(metadata))
  for (const name of names.filter(name => name.endsWith('.blockmap'))) writeFileSync(join(directory, name), 'example blockmap')
  const sums = names.map(name => sha('sha256', readFileSync(join(directory, name))) + '  ' + name + '\n').join('')
  writeFileSync(join(directory, platform === 'macos' ? 'SHA256SUMS.txt' : 'SHA256SUMS-windows.txt'), sums)
}

for (const target of ['all', 'macos', 'windows']) {
  test(target + ' tag, manual preflight and pull request selection', () => {
    const metadata = { version, toushouReleaseTarget: target }
    assert.deepEqual(plan('push', metadata, 'refs/tags/v' + version), { version, target })
    assert.equal(plan('workflow_dispatch', { version, toushouReleaseTarget: 'all' }, 'refs/heads/main', target).target, target)
    assert.equal(plan('pull_request', metadata, 'refs/pull/1/merge').target, 'all')
  })

  test(target + ' verifies its entire public asset set and rejects unrelated files', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'release-verify-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    for (const platform of platforms(target)) stage(directory, platform)
    await verifyFiles(target, directory, version, JSON.parse)
    writeFileSync(join(directory, 'unexpected.bin'), 'unused')
    await assert.rejects(verifyFiles(target, directory, version, JSON.parse), /Unexpected or missing/)
  })
}

test('stable pushes need the matching numeric tag, selected platform and complete bridge', () => {
  const meta = { version, toushouReleaseTarget: 'windows' }
  assert.throws(() => plan('push', meta, 'refs/heads/main'))
  assert.throws(() => plan('push', meta, 'refs/tags/v2.9.8'))
  assert.throws(() => plan('push', { version: '02.9.8', toushouReleaseTarget: 'all' }, 'refs/tags/v02.9.8'))
  assert.throws(() => plan('push', { version, toushouReleaseTarget: 'linux' }, 'refs/tags/v' + version))
  assert.throws(() => plan('push', { version: '2.9.8', toushouReleaseTarget: 'windows' }, 'refs/tags/v2.9.8'))
  assert.equal(plan('push', { version: '2.9.8', toushouReleaseTarget: 'all' }, 'refs/tags/v2.9.8').target, 'all')
})

test('a recovery can only use a stable tag, exact commit and previously failed push from the default main workflow', () => {
  const control = 'a'.repeat(40)
  const commit = 'b'.repeat(40)
  const tag = 'v2.9.8'
  const event = { action: 'recover-stable-release', repository: { default_branch: 'main' }, client_payload: { tag, commit } }
  const resolve = (payload, ref = 'refs/heads/main', failedRun = () => '42') => resolveSource('repository_dispatch', ref, control, payload, failedRun)
  assert.deepEqual(resolve(event, undefined, (actualTag, actualCommit) => {
    assert.equal(actualTag, tag)
    assert.equal(actualCommit, commit)
    return '45'
  }), { control, source: commit, tag, mode: 'recovery', failed_run: '45' })
  assert.throws(() => resolve(event, 'refs/heads/feature'))
  assert.throws(() => resolve({ ...event, action: 'other' }))
  assert.throws(() => resolve({ ...event, repository: { default_branch: 'other' } }))
  for (const bad of [{ tag: 'main', commit }, { tag, commit: 'short' }, { tag, commit, target: 'macos' }]) {
    assert.throws(() => resolve({ ...event, client_payload: bad }))
  }
  assert.throws(() => resolve(event, undefined, () => ''), /failed tag-push/)
  assert.equal(resolveSource('workflow_dispatch', 'refs/heads/main', control, event, () => {}).mode, 'preflight')
  assert.equal(resolveSource('pull_request', 'refs/pull/1/merge', control, event, () => {}).mode, 'preflight')
  assert.deepEqual(resolveSource('push', 'refs/tags/' + tag, commit, {}, () => {}), { control: commit, source: commit, tag, mode: 'release' })
})

test('a new release advances the numeric global version along main and the bridge exists', () => {
  const tags = ['v2.9.8', 'beta-v9.0.0-beta.1', 'v2.9.9', 'v2.9.10-beta.1']
  const ancestors = []
  assert.equal(guardHistory('2.9.10', tags, (...edge) => ancestors.push(edge)), false)
  assert.deepEqual(ancestors, [['refs/tags/v2.9.9^{commit}', 'HEAD']])
  assert.throws(() => guardHistory('2.9.7', tags, () => {}), /newer/)
  assert.throws(() => guardHistory('2.9.10', ['v2.9.7'], () => {}), /bridge first/)
  assert.throws(() => guardHistory('2.9.10', tags, () => { throw new Error('not an ancestor') }), /ancestor/)
  assert.equal(guardHistory('2.9.9', [...tags, 'v2.10.0'], () => {}), true)
})

test('Windows can finish after a newer Mac release while a fresh low-version tag still fails', () => {
  const win = '2.9.9'
  const mac = '2.9.10'
  const bridge = 'v2.9.8'
  const ancestry = []
  const check = (...pair) => ancestry.push(pair)
  assert.equal(guardHistory(win, [bridge], check, 'plan'), false)
  assert.equal(guardHistory(mac, [bridge], check, 'plan'), false)
  const nowPublic = [bridge, 'v' + mac]
  assert.throws(() => guardHistory(win, nowPublic, check, 'plan'), /newer/)
  ancestry.length = 0
  assert.equal(guardHistory(win, nowPublic, check, 'publish'), false)
  assert.deepEqual(ancestry, [
    ['HEAD', 'refs/tags/v2.9.10^{commit}'],
    ['refs/tags/v2.9.8^{commit}', 'HEAD']
  ])
  assert.throws(() => guardHistory(win, nowPublic, (first) => {
    if (first === 'HEAD') throw new Error('late version is not an ancestor of published Mac')
  }, 'publish'), /not an ancestor/)
})

test('a missing, corrupt or cross-version installer blocks publication', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'release-integrity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const verify = () => verifyFiles('windows', dir, version, JSON.parse)
  stage(dir, 'windows')
  rmSync(join(dir, 'TouShou-x64.exe.blockmap'))
  await assert.rejects(verify(), /missing/)
  stage(dir, 'windows')
  writeFileSync(join(dir, 'TouShou-x64.exe'), 'changed')
  await assert.rejects(verify(), /SHA-256/)
  stage(dir, 'windows', metadata => { metadata.version = '2.9.8' })
  await assert.rejects(verify(), /Update manifest/)
  stage(dir, 'windows', metadata => { metadata.files[0].sha512 = 'incorrect' })
  await assert.rejects(verify(), /SHA-512/)
  stage(dir, 'windows', metadata => { metadata.path = 'wrong.exe' })
  await assert.rejects(verify(), /primary/)
})

test('an omitted target may skip, but no selected platform may fail, cancel or skip', () => {
  for (const [target, mac, win] of [['all', 'success', 'success'], ['macos', 'success', 'skipped'], ['windows', 'skipped', 'success']]) {
    checkBuilds(target, mac, win)
    assert.throws(() => checkBuilds(target, 'failure', win))
    assert.throws(() => checkBuilds(target, mac, 'cancelled'))
    assert.throws(() => checkBuilds(target, 'skipped', 'skipped'))
  }
})

test('pushed tags must be on remote main before a formal build can start', { skip: process.platform === 'win32' }, t => {
  const temporary = mkdtempSync(join(tmpdir(), 'release-source-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const directory = join(temporary, 'source')
  mkdirSync(directory)
  const remote = join(temporary, 'remote.git')
  const git = (...args) => execFileSync('git', ['-c', 'user.name=release-fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '--bare', remote)
  git('init', '--initial-branch=main')
  git('remote', 'add', 'origin', remote)
  mkdirSync(join(directory, 'tools'))
  const script = join(directory, 'tools/release-verify.cjs')
  copyFileSync(require.resolve('../tools/release-verify.cjs'), script)
  const metadata = join(directory, 'package.json')
  writeFileSync(metadata, JSON.stringify({ version: '2.9.7' }))
  git('add', '.')
  git('commit', '-m', 'base')
  git('tag', 'v2.9.7')
  git('push', 'origin', 'main', 'v2.9.7')
  writeFileSync(metadata, JSON.stringify({ version: '2.9.8', toushouReleaseTarget: 'all' }))
  git('commit', '-am', 'bridge')
  git('tag', '-a', 'v2.9.8', '-m', 'bridge')
  git('push', 'origin', 'v2.9.8')
  // Simulate checkout@v4's event ref at the commit while the remote tag is annotated.
  git('tag', '-f', 'v2.9.8', 'HEAD')
  const fakeBin = join(temporary, 'bin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'gh'), '#!/bin/sh\necho v2.9.7\n', { mode: 0o700 })
  const run = () => spawnSync(process.execPath, [script, 'plan'], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: fakeBin + ':' + process.env.PATH,
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v2.9.8' }
  })
  assert.notEqual(run().status, 0)
  git('push', 'origin', 'main')
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /version=2\.9\.8\ntarget=all/)
  // Recovery runs the control script from main against the original checkout.
  const control = join(temporary, 'control')
  mkdirSync(join(control, 'tools'), { recursive: true })
  writeFileSync(join(control, 'package.json'), JSON.stringify({ version: '10.0.0', toushouReleaseTarget: 'windows' }))
  const controlScript = join(control, 'tools/release-verify.cjs')
  copyFileSync(script, controlScript)
  const original = git('rev-parse', 'HEAD').toString().trim()
  const recoveryEnv = { ...process.env, PATH: fakeBin + ':' + process.env.PATH, GITHUB_EVENT_NAME: 'repository_dispatch',
    GITHUB_REF: 'refs/heads/main', RELEASE_TAG: 'v2.9.8', SOURCE_SHA: original }
  const recovered = spawnSync(process.execPath, [controlScript, 'plan'], { cwd: directory, encoding: 'utf8', env: recoveryEnv })
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.equal(recovered.stdout.trim(), 'version=2.9.8\ntarget=all')
  const wrongSource = spawnSync(process.execPath, [controlScript, 'check-publish'], {
    cwd: directory, encoding: 'utf8', env: { ...recoveryEnv, SOURCE_SHA: '0'.repeat(40) }
  })
  assert.notEqual(wrongSource.status, 0)

  git('--git-dir=' + remote, 'update-ref', 'refs/tags/v2.9.8', 'refs/tags/v2.9.7')
  const changedTag = run()
  assert.notEqual(changedTag.status, 0)
  assert.match(changedTag.stderr, /Remote release tag and checked-out commit differ/)
})

test('publishing and signing require a GitHub push or recovery event even if a preflight reports release mode', () => {
  const text = readFileSync(join(__dirname, '../.github/workflows/release.yml'), 'utf8')
  const eventGate = "(github.event_name == 'push' || github.event_name == 'repository_dispatch') && needs.plan.outputs.mode != 'preflight'"
  const secrets = text.split('\n').filter(line => line.includes('&& secrets.'))
  assert.equal(secrets.length, 5)
  for (const line of secrets) assert.ok(line.includes(eventGate))
  for (const job of ['publish', 'promote']) {
    const start = text.indexOf('\n  ' + job + ':\n')
    const gate = text.slice(start).split('\n').find(line => line.startsWith('    if:'))
    assert.ok(gate && gate.includes(eventGate), job)
  }
})
