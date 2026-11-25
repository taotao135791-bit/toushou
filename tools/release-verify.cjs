// Stable-release planning and artifact verification. Only the two history checks read GitHub.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { createReadStream, lstatSync, readdirSync, readFileSync } = require('node:fs')
const path = require('node:path')

const bridgeVersion = '2.9.8'
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const platformFiles = {
  macos: {
    manifest: 'latest-mac.yml', sums: 'SHA256SUMS.txt',
    installers: ['TouShou-arm64.dmg', 'TouShou-arm64.zip', 'TouShou-x64.dmg', 'TouShou-x64.zip']
  },
  windows: { manifest: 'latest.yml', sums: 'SHA256SUMS-windows.txt', installers: ['TouShou-x64.exe'] }
}

function platforms(target) {
  if (target === 'all') return ['macos', 'windows']
  if (Object.hasOwn(platformFiles, target)) return [target]
  throw new Error('Expected release target all, macos or windows')
}

function checkBuilds(target, macos, windows) {
  const selected = platforms(target)
  for (const [platform, result] of Object.entries({ macos, windows })) {
    const expected = selected.includes(platform) ? 'success' : 'skipped'
    if (result !== expected) throw new Error(platform + ' build was ' + result + ', expected ' + expected)
  }
}

function plan(event, metadata, ref, manualTarget) {
  const { version, toushouReleaseTarget } = metadata
  if (!stableVersion.test(version)) throw new Error('Expected stable package version X.Y.Z')
  let target
  if (event === 'push') {
    if (ref !== 'refs/tags/v' + version) throw new Error('Expected a tag matching package.json version')
    target = toushouReleaseTarget
    if (version === bridgeVersion && target !== 'all') throw new Error('The bridge release must include both platforms')
  } else if (event === 'workflow_dispatch') {
    target = manualTarget
  } else if (event === 'pull_request') {
    target = 'all'
  } else {
    throw new Error('Unsupported release event')
  }
  platforms(target)
  return { version, target }
}

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt)
  const b = right.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  }
  return 0
}

function guardHistory(version, tags, ancestor, phase = 'plan') {
  // An already-public tag may be rechecked and promoted again; promotion never rolls back a channel.
  const versions = tags.filter(tag => tag.startsWith('v') && stableVersion.test(tag.slice(1))).map(tag => tag.slice(1))
  const published = versions.includes(version)
  if (!published) {
    const newer = versions.filter(v => compareVersions(v, version) > 0)
    if (phase === 'plan' && newer.length) throw new Error('A newer stable release is already public')
    // Another platform can finish first after this tag passed plan. Allow its ancestor
    // to finish packaging; platform pointers only advance to a higher version.
    for (const later of newer) ancestor('HEAD', 'refs/tags/v' + later + '^{commit}')
  }
  if (compareVersions(version, bridgeVersion) > 0 && !versions.includes(bridgeVersion)) throw new Error('Publish the dual-platform bridge first')
  const previous = versions.filter(v => compareVersions(v, version) < 0).sort(compareVersions).pop()
  if (previous) ancestor('refs/tags/v' + previous + '^{commit}', 'HEAD')
  return published
}

function checkTag(version, phase) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const ref = 'refs/tags/v' + version
  if (process.env.GITHUB_REF !== ref || git('rev-parse', ref + '^{commit}') !== git('rev-parse', 'HEAD')) {
    throw new Error('Release tag and checked-out commit differ')
  }
  // checkout may materialize the event tag as a lightweight tag at the commit.
  // Compare peeled commits without replacing the checkout's local tag object.
  const remoteTag = 'refs/toushou-release-check/remote-tag'
  git('fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main', '+' + ref + ':' + remoteTag)
  if (git('rev-parse', remoteTag + '^{commit}') !== git('rev-parse', 'HEAD')) {
    throw new Error('Remote release tag and checked-out commit differ')
  }
  const ancestor = (first, second) => git('merge-base', '--is-ancestor', first, second)
  ancestor('HEAD', 'refs/remotes/origin/main')
  const result = execFileSync('gh', ['api', '--paginate', 'repos/{owner}/{repo}/releases?per_page=100',
    '--jq', '.[] | select(.draft == false and .prerelease == false) | .tag_name'], { encoding: 'utf8' })
  return guardHistory(version, result.trim().split(/\r?\n/), ancestor, phase)
}

function payloadNames(platform) {
  const { manifest, installers } = platformFiles[platform]
  return [manifest, ...installers, ...installers.map(name => name + '.blockmap')]
}

async function fileDigests(filename, includeSha512) {
  const sha256 = createHash('sha256')
  const sha512 = includeSha512 && createHash('sha512')
  for await (const chunk of createReadStream(filename)) {
    sha256.update(chunk)
    if (sha512) sha512.update(chunk)
  }
  return { sha256: sha256.digest('hex'), sha512: sha512 ? sha512.digest('base64') : undefined }
}

async function verifyFiles(target, directory, version, parseManifest) {
  const selected = platforms(target)
  const expected = selected.flatMap(platform => [...payloadNames(platform), platformFiles[platform].sums]).sort()
  if (readdirSync(directory).sort().join('\n') !== expected.join('\n')) throw new Error('Unexpected or missing release files in ' + directory)
  for (const name of expected) {
    const file = lstatSync(path.join(directory, name))
    if (!file.isFile() || !file.size) throw new Error('Missing or empty release file: ' + name)
  }
  for (const platform of selected) {
    const { manifest, sums, installers } = platformFiles[platform]
    const names = payloadNames(platform)
    const lines = readFileSync(path.join(directory, sums), 'utf8').trimEnd().split(/\r?\n/)
    const checksums = new Map()
    for (const line of lines) {
      const match = /^([\da-f]{64}) [ *](.+)$/i.exec(line)
      if (!match || !names.includes(match[2]) || checksums.has(match[2])) throw new Error('Invalid checksum entry in ' + sums)
      checksums.set(match[2], match[1].toLowerCase())
    }
    if (checksums.size !== names.length) throw new Error('Incomplete checksum coverage in ' + sums)
    const metadata = parseManifest(readFileSync(path.join(directory, manifest), 'utf8'))
    if (!metadata || metadata.version !== version || !Array.isArray(metadata.files) ||
        metadata.files.map(file => file.url).sort().join('\n') !== [...installers].sort().join('\n')) {
      throw new Error('Update manifest must match this version and its installers: ' + manifest)
    }
    for (const name of names) {
      const filename = path.join(directory, name)
      const entry = metadata.files.find(file => file.url === name)
      const hash = await fileDigests(filename, !!entry)
      if (hash.sha256 !== checksums.get(name)) throw new Error('SHA-256 mismatch: ' + name)
      if (entry && (hash.sha512 !== entry.sha512 || lstatSync(filename).size !== entry.size)) {
        throw new Error('Update manifest size or SHA-512 mismatch: ' + name)
      }
    }
    const primary = metadata.files.find(file => file.url === metadata.path)
    if (!primary || primary.sha512 !== metadata.sha512) throw new Error('Invalid primary update file in ' + manifest)
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'plan') {
    const result = plan(process.env.GITHUB_EVENT_NAME, require('../package.json'), process.env.GITHUB_REF, process.env.MANUAL_TARGET)
    if (process.env.GITHUB_EVENT_NAME === 'push') checkTag(result.version, 'plan')
    console.log('version=' + result.version + '\ntarget=' + result.target)
  } else if (command === 'check-publish') {
    console.log(checkTag(require('../package.json').version, 'publish') ? 'public' : 'unpublished')
  } else if (command === 'check-builds') {
    checkBuilds(...args)
  } else if (command === 'verify') {
    const [target, directory] = args
    await verifyFiles(target, directory, require('../package.json').version, require('yaml').parse)
  } else {
    throw new Error('Expected plan, check-publish, check-builds or verify')
  }
}

module.exports = { platforms, checkBuilds, plan, guardHistory, payloadNames, verifyFiles }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
