import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { promote } = createRequire(import.meta.url)('../../../tools/promote-release-channels.cjs')
const repo = 'example/desktop'
const bridge = { schemaVersion: 1, macos: '2.9.8', windows: '2.9.8' }
const mac = ['latest-mac.yml', 'SHA256SUMS.txt', ...['arm64', 'x64'].flatMap(arch => ['.dmg', '.dmg.blockmap', '.zip', '.zip.blockmap'].map(ext => `TouShou-${arch}${ext}`))]
const windows = ['latest.yml', 'SHA256SUMS-windows.txt', 'TouShou-x64.exe', 'TouShou-x64.exe.blockmap']
const assets = (names: string[]) => names.map(name => ({ name, size: 16, state: 'uploaded' }))

type GitFile = { path: string; content: string }
type Commit = { tree: string; parents: string[] }

// Model Git's optimistic fast-forward rule. A test may run another full
// promotion just before the first publication attempts to update the ref.
function repository() {
  const commits = new Map<string, Commit>()
  const trees = new Map<string, GitFile[]>()
  let head: string | null = null
  let sequence = 0
  const options = {
    beforeRef: null as null | (() => void),
    afterRef: null as null | (() => void),
    release: {} as Record<string, unknown>
  }
  function api(method: string, resource: string, body?: any): any {
    if (method === 'GET' && resource.startsWith('releases/tags/')) {
      return { tag_name: resource.split('/').pop(), draft: false, prerelease: false, published_at: '2026-01-01',
        assets: assets([...mac, ...windows]), ...options.release }
    }
    if (method === 'GET' && resource === 'git/ref/heads/release-channels') {
      if (!head) throw Object.assign(new Error('not found'), { status: 404 })
      return { object: { sha: head } }
    }
    if (method === 'GET' && resource.startsWith('contents/stable.json?ref=')) {
      const version = resource.split('=').pop()!
      const files = trees.get(commits.get(version)!.tree)!
      return { type: 'file', encoding: 'base64', content: Buffer.from(files.find(file => file.path === 'stable.json')!.content).toString('base64') }
    }
    if (method === 'GET' && resource.startsWith('git/commits/')) {
      return { tree: { sha: commits.get(resource.split('/').pop()!)!.tree } }
    }
    if (method === 'POST' && resource === 'git/trees') {
      const sha = `tree${++sequence}`
      trees.set(sha, body.tree)
      return { sha }
    }
    if (method === 'POST' && resource === 'git/commits') {
      const sha = `commit${++sequence}`
      commits.set(sha, body)
      return { sha }
    }
    if (method === 'PATCH' && resource === 'git/refs/heads/release-channels' || method === 'POST' && resource === 'git/refs') {
      const { beforeRef } = options
      options.beforeRef = null
      beforeRef?.()
      const { parents } = commits.get(body.sha)!
      if (method === 'PATCH') {
        expect(body.force).toBe(false)
        if (parents[0] !== head) throw new Error('not a fast-forward')
      } else if (head) {
        throw new Error('already exists')
      } else {
        expect(body.ref).toBe('refs/heads/release-channels')
        expect(parents).toEqual([])
      }
      head = body.sha
      const { afterRef } = options
      options.afterRef = null
      afterRef?.()
      return {}
    }
    throw new Error(`Unexpected API request: ${method} ${resource}`)
  }
  return {
    options, commits,
    get head() { return head },
    get files() { return trees.get(commits.get(head!)!.tree)! },
    run: (version: string, target: string) => promote(repo, version, target, api)
  }
}

describe('stable platform channel publication', () => {
  it('bootstraps once with two manifests in one root commit and generates a version-pinned download page', () => {
    const git = repository()
    expect(() => git.run('2.9.8', 'macos')).toThrow(/dual-platform/)
    expect(() => git.run('2.9.9', 'all')).toThrow(/dual-platform/)
    expect(git.head).toBeNull()
    expect(git.run('2.9.8', 'all')).toEqual(bridge)
    expect(JSON.parse(git.files.find(file => file.path === 'stable.json')!.content)).toEqual(bridge)
    expect(git.files.map(file => file.path).sort()).toEqual(['README.md', 'stable.json'])
    const firstHead = git.head
    git.run('2.9.8', 'all')
    expect(git.head).toBe(firstHead)
    expect(git.commits.size).toBe(1)
  })

  it('promotes a single platform using only the assets published for that platform', () => {
    const git = repository()
    git.run('2.9.8', 'all')
    git.options.release.assets = assets(mac)
    expect(git.run('2.9.10', 'macos')).toEqual({ ...bridge, macos: '2.9.10' })
    const readme = git.files.find(file => file.path === 'README.md')!.content
    expect(readme).toContain('/v2.9.10/TouShou-arm64.dmg')
    expect(readme).toContain('/v2.9.10/TouShou-x64.zip')
    expect(readme).toContain('/v2.9.8/TouShou-x64.exe')
    git.options.release.assets = assets(windows)
    expect(git.run('2.9.9', 'windows')).toEqual({ schemaVersion: 1, windows: '2.9.9', macos: '2.9.10' })
    git.options.release.assets = assets([...mac, ...windows])
    expect(git.run('2.10.0', 'all')).toEqual({ schemaVersion: 1, windows: '2.10.0', macos: '2.10.0' })
  })

  it('retries after concurrent publication without losing the other platform’s version', () => {
    const git = repository()
    git.run('2.9.8', 'all')
    git.options.beforeRef = () => git.run('2.9.10', 'windows')
    expect(git.run('2.9.9', 'macos')).toEqual({ schemaVersion: 1, macos: '2.9.9', windows: '2.9.10' })
    const macHead = git.head
    git.run('2.9.8', 'all')
    expect(git.head).toBe(macHead)
  })

  it('keeps a faster winner on a platform and can advance the other platform from the same older dual-platform run', () => {
    const git = repository()
    git.run('2.9.8', 'all')
    git.options.beforeRef = () => git.run('2.9.11', 'macos')
    expect(git.run('2.9.10', 'all')).toEqual({ schemaVersion: 1, macos: '2.9.11', windows: '2.9.10' })
  })

  it('recovers a lost response and a concurrent initial create without duplicate public commits', () => {
    const git = repository()
    git.options.beforeRef = () => git.run('2.9.8', 'all')
    expect(git.run('2.9.8', 'all')).toEqual(bridge)
    git.options.afterRef = () => { throw new Error('lost connection') }
    expect(git.run('2.9.9', 'windows')).toEqual({ ...bridge, windows: '2.9.9' })
  })

  it('leaves the branch intact on bad releases, incomplete assets or a failed ref update', () => {
    const git = repository()
    git.run('2.9.8', 'all')
    const firstHead = git.head
    for (const metadata of [
      { draft: true }, { prerelease: true }, { published_at: null }, { tag_name: 'v2.9.8' },
      { assets: assets(mac) }, { assets: assets(windows).map(asset => ({ ...asset, size: 0 })) },
      { assets: assets(windows).map(asset => ({ ...asset, state: 'open' })) }
    ]) {
      git.options.release = metadata
      expect(() => git.run('2.9.9', 'windows')).toThrow()
      expect(git.head).toBe(firstHead)
    }
    git.options.release = {}
    git.options.beforeRef = () => { throw new Error('permission denied') }
    expect(() => git.run('2.9.9', 'all')).toThrow('permission denied')
    expect(git.head).toBe(firstHead)
    for (const version of ['2.9.09', '2.9.9-test', '2.9.9\n']) expect(() => git.run(version, 'all')).toThrow()
    expect(() => git.run('2.9.9', 'linux')).toThrow()
  })
})
