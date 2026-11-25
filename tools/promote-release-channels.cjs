const { spawnSync } = require('node:child_process')

const branch = 'release-channels'
const bridgeVersion = '2.9.8'
const platforms = ['macos', 'windows']
const bot = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' }
const requiredAssets = {
  macos: ['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].flatMap(ext => [
    `TouShou-${arch}.${ext}`, `TouShou-${arch}.${ext}.blockmap`
  ])).concat('latest-mac.yml', 'SHA256SUMS.txt'),
  windows: ['TouShou-x64.exe', 'TouShou-x64.exe.blockmap', 'latest.yml', 'SHA256SUMS-windows.txt']
}

function versionParts(value) {
  if (typeof value !== 'string' || value.trim() !== value || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid stable version: ${value}`)
  }
  const parts = value.split('.').map(Number)
  if (!parts.every(Number.isSafeInteger)) throw new Error(`Invalid stable version: ${value}`)
  return parts
}

function isNewer(candidate, old) {
  const a = versionParts(candidate)
  const b = versionParts(old)
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index]
  }
  return false
}

function downloadPage(repo, channels) {
  const assets = `https://github.com/${repo}/releases/download`
  const notes = `https://github.com/${repo}/releases/tag`
  const mac = `v${channels.macos}`
  const win = `v${channels.windows}`
  return `# 投手下载

| 平台 | 当前版本 | 安装包 |
| --- | --- | --- |
| macOS Apple Silicon | [${mac}](${notes}/${mac}) | [DMG](${assets}/${mac}/TouShou-arm64.dmg) · [ZIP](${assets}/${mac}/TouShou-arm64.zip) |
| macOS Intel | [${mac}](${notes}/${mac}) | [DMG](${assets}/${mac}/TouShou-x64.dmg) · [ZIP](${assets}/${mac}/TouShou-x64.zip) |
| Windows x64 | [${win}](${notes}/${win}) | [安装程序](${assets}/${win}/TouShou-x64.exe) |

选择你的平台下载安装。点击版本号可以查看该版本的更新说明和校验文件。
`
}

function githubApi(repo) {
  return (method, resource, body) => {
    const args = ['api', '--method', method, `repos/${repo}/${resource}`]
    if (body !== undefined) args.push('--input', '-')
    const result = spawnSync('gh', args, {
      encoding: 'utf8', input: JSON.stringify(body), stdio: ['pipe', 'pipe', 'pipe']
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      const error = new Error(result.stderr.trim() || `GitHub request failed: ${method} ${resource}`)
      error.status = Number(result.stderr.match(/\(HTTP (\d+)\)/)?.[1])
      throw error
    }
    return JSON.parse(result.stdout)
  }
}

function currentHead(api) {
  try {
    return api('GET', `git/ref/heads/${branch}`).object.sha
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

function readChannels(api, head) {
  // Pin the contents read to the revision used as this write's parent.
  const file = api('GET', `contents/stable.json?ref=${head}`)
  if (file.type !== 'file' || file.encoding !== 'base64') throw new Error('Invalid stable.json file')
  const channels = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
  if (channels?.schemaVersion !== 1 || Object.keys(channels).length !== 3) throw new Error('Unknown channel schema')
  for (const key of platforms) versionParts(channels[key])
  return channels
}

function promote(repo, version, target, api = githubApi(repo)) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Expected GH_REPO in owner/repository form')
  versionParts(version)
  if (target !== 'all' && !platforms.includes(target)) throw new Error('Expected all, macos or windows')
  const selected = target === 'all' ? platforms : [target]
  const release = api('GET', `releases/tags/v${version}`)
  if (release.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false || !release.published_at) {
    throw new Error(`Expected a public stable release for v${version}`)
  }
  const uploaded = new Set(release.assets.filter(asset => asset.state === 'uploaded' && asset.size > 0).map(asset => asset.name))
  for (const key of selected) {
    for (const name of requiredAssets[key]) {
      if (!uploaded.has(name)) throw new Error(`Missing uploaded asset for ${key}: ${name}`)
    }
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const head = currentHead(api)
    if (!head && (version !== bridgeVersion || target !== 'all')) {
      throw new Error(`Initialize the channels from the dual-platform v${bridgeVersion} release`)
    }
    const current = head ? readChannels(api, head) : null
    const channels = current ? { ...current } : { schemaVersion: 1, macos: bridgeVersion, windows: bridgeVersion }
    if (current) {
      const advancing = selected.filter(key => isNewer(version, current[key]))
      if (advancing.length === 0) return channels
      for (const key of advancing) channels[key] = version
    }

    const tree = [
      { path: 'stable.json', mode: '100644', type: 'blob', content: JSON.stringify(channels, null, 2) + '\n' },
      { path: 'README.md', mode: '100644', type: 'blob', content: downloadPage(repo, channels) }
    ]
    const base = head ? { base_tree: api('GET', `git/commits/${head}`).tree.sha } : {}
    const snapshot = api('POST', 'git/trees', { ...base, tree })
    const commit = api('POST', 'git/commits', {
      message: `release: promote ${target} to v${version}`,
      tree: snapshot.sha, parents: head ? [head] : [], author: bot, committer: bot
    })
    try {
      if (head) {
        api('PATCH', `git/refs/heads/${branch}`, { sha: commit.sha, force: false })
      } else {
        api('POST', 'git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha })
      }
      return channels
    } catch (error) {
      // A concurrent publication can win between reading the branch and this
      // non-forced fast-forward. Recompute both channels against today's head.
      // This also recovers a successful update whose response was lost.
      if (currentHead(api) === head) throw error
    }
  }
  throw new Error('Concurrent channel updates continued; retry the release workflow')
}

if (require.main === module) {
  try {
    const [version, target] = process.argv.slice(2)
    console.log(JSON.stringify(promote(process.env.GH_REPO || '', version, target)))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { promote }
