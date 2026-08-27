import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bundledCatalogFile,
  catalogOrigin,
  listOmpModelCatalog,
  refreshModelCatalog,
  refreshedCatalogFile
} from '../omp/settings/OmpModelCatalog'

let root: string
let appPath: string
let userDataDir: string

const CATALOG = {
  'test-prov': {
    'model-a': { id: 'model-a', name: 'Model A', provider: 'test-prov', reasoning: true },
    'test-prov/model-b': { id: 'test-prov/model-b', name: 'Model B' }
  }
}

function writeBundled(catalog: unknown = CATALOG): void {
  const dir = path.join(appPath, 'resources', 'pi-catalog')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'models.json'), JSON.stringify(catalog))
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'omp-catalog-test-'))
  appPath = path.join(root, 'app')
  userDataDir = path.join(root, 'userData')
  mkdirSync(appPath, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('layered catalog loading', () => {
  it('falls back to the bundled snapshot', async () => {
    writeBundled()
    const models = await listOmpModelCatalog(undefined, { appPath, userDataDir })
    const ids = models.filter((m) => m.provider === 'test-prov').map((m) => m.id)
    expect(ids).toEqual(['model-a', 'model-b'])
    expect(catalogOrigin({ appPath, userDataDir })).toBe('bundled')
  })

  it('prefers the refreshed userData copy over the bundled snapshot', async () => {
    writeBundled()
    writeFileSync(
      refreshedCatalogFile(userDataDir)!,
      JSON.stringify({ 'refreshed-prov': { m: { id: 'm', name: 'M' } } })
    )
    const models = await listOmpModelCatalog(undefined, { appPath, userDataDir })
    expect(models.map((m) => m.provider)).toEqual(['refreshed-prov'])
    expect(catalogOrigin({ appPath, userDataDir })).toBe('refreshed')
  })

  it('normalizes bare ids into provider/id selectors', async () => {
    writeBundled()
    const models = await listOmpModelCatalog('test-prov', { appPath, userDataDir })
    expect(models.map((m) => m.selector)).toEqual(['test-prov/model-a', 'test-prov/model-b'])
    expect(models[0].reasoning).toBe(true)
  })

  it('returns empty with honest origin when nothing exists', async () => {
    expect(await listOmpModelCatalog(undefined, { appPath, userDataDir })).toEqual([])
    expect(catalogOrigin({ appPath, userDataDir })).toBe('none')
    expect(bundledCatalogFile(appPath)).toContain('resources')
  })

  it('skips a corrupt layer and uses the next one', async () => {
    writeBundled()
    writeFileSync(refreshedCatalogFile(userDataDir)!, 'not json')
    const models = await listOmpModelCatalog(undefined, { appPath, userDataDir })
    expect(models.length).toBe(2)
    expect(catalogOrigin({ appPath, userDataDir })).toBe('bundled')
  })
})

describe('refreshModelCatalog', () => {
  const fakeFetch = (body: string, status = 200): typeof fetch =>
    (() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(body)
      })) as unknown as typeof fetch

  it('downloads, validates and atomically writes the userData copy', async () => {
    const catalog = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`p${i}`, { m: { id: 'm', name: 'M' } }])
    )
    const r = await refreshModelCatalog({ userDataDir }, fakeFetch(JSON.stringify(catalog)))
    expect(r).toEqual({ ok: true, providers: 12 })
    const written = JSON.parse(readFileSync(refreshedCatalogFile(userDataDir)!, 'utf-8'))
    expect(Object.keys(written)).toHaveLength(12)
  })

  it('rejects invalid JSON without touching the existing copy', async () => {
    writeFileSync(refreshedCatalogFile(userDataDir)!, JSON.stringify(CATALOG))
    const r = await refreshModelCatalog({ userDataDir }, fakeFetch('garbage'))
    expect(r.ok).toBe(false)
    expect(JSON.parse(readFileSync(refreshedCatalogFile(userDataDir)!, 'utf-8'))).toEqual(CATALOG)
  })

  it('rejects a JSON payload that is not a provider catalog', async () => {
    const r = await refreshModelCatalog({ userDataDir }, fakeFetch('{"a":1}'))
    expect(r.ok).toBe(false)
    expect(existsSync(refreshedCatalogFile(userDataDir)!)).toBe(false)
  })

  it('reports HTTP failures', async () => {
    const r = await refreshModelCatalog({ userDataDir }, fakeFetch('', 500))
    expect(r).toMatchObject({ ok: false, error: 'download failed (500)' })
  })
})
