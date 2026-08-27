import { describe, it, expect, vi, afterEach } from 'vitest'
import { CURATED_GIT_PACKAGES, searchCommunityPackages } from '../community'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CURATED_GIT_PACKAGES', () => {
  it('lists unique GitHub repos with complete metadata', () => {
    expect(CURATED_GIT_PACKAGES).toHaveLength(11)
    const repos = CURATED_GIT_PACKAGES.map((p) => p.repo)
    expect(new Set(repos).size).toBe(repos.length)
    for (const p of CURATED_GIT_PACKAGES) {
      expect(p.repo).toMatch(/^[a-z0-9-]+\/[a-z0-9._-]+$/i)
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.description.length).toBeGreaterThan(0)
      expect(p.category.length).toBeGreaterThan(0)
    }
  })
})

describe('searchCommunityPackages (curatedOnly)', () => {
  it('returns the static curated list without touching the network', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const list = await searchCommunityPackages('', true)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(list).toHaveLength(CURATED_GIT_PACKAGES.length)
    expect(list[0]).toMatchObject({
      name: CURATED_GIT_PACKAGES[0].name,
      repo: CURATED_GIT_PACKAGES[0].repo,
      description: CURATED_GIT_PACKAGES[0].description,
      category: CURATED_GIT_PACKAGES[0].category
    })
  })
})

describe('searchCommunityPackages (registry search)', () => {
  it('maps registry hits and skips malformed entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          objects: [
            { package: { name: 'pi-demo', description: 'demo', version: '1.0.0' } },
            { package: { description: 'nameless' } },
            { package: { name: 'pi-two', description: 42, version: null } }
          ]
        })
      }))
    )
    const list = await searchCommunityPackages('demo')
    expect(list).toEqual([
      { name: 'pi-demo', description: 'demo', version: '1.0.0' },
      { name: 'pi-two', description: '', version: '' }
    ])
  })

  it('returns [] on HTTP errors and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    expect(await searchCommunityPackages('x')).toEqual([])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    expect(await searchCommunityPackages('x')).toEqual([])
  })
})
