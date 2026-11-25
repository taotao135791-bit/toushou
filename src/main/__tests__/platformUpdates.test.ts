import { describe, expect, it } from 'vitest'
import { pickStableVersion, platformAsset, releaseBase } from '../platformUpdates'

const sha512 = Buffer.alloc(64).toString('base64')
const index = { schemaVersion: 1, macos: '2.9.9', windows: '2.9.8' }
const macFiles = ['TouShou-arm64.zip', 'TouShou-x64.zip', 'TouShou-arm64.dmg', 'TouShou-x64.dmg']
  .map(url => ({ url, sha512 }))

describe('stable platform release metadata', () => {
  it('allows either platform to advance without redirecting the other', () => {
    for (const [macos, windows] of [['2.9.9', '2.9.8'], ['2.9.8', '2.10.0']]) {
      const json = JSON.stringify({ schemaVersion: 1, macos, windows })
      expect(pickStableVersion(json, 'macos')).toBe(macos)
      expect(pickStableVersion(json, 'windows')).toBe(windows)
    }
  })

  it.each(['2.9.8-beta.1', '2.9.8+win', '../win', '02.9.8', '2.9', 'v2.9.8', '999999999999999999.0.0', null])('rejects non-release versions %p', value => {
    expect(() => pickStableVersion(JSON.stringify({ ...index, windows: value }), 'macos')).toThrow()
  })

  it.each([{ ...index, schemaVersion: 2 }, { ...index, download: 'https://example.com' }, { macos: '2.9.8' }])('requires the exact platform index', invalid => {
    expect(() => pickStableVersion(JSON.stringify(invalid), 'macos')).toThrow()
  })

  it('supports existing standard release manifests and selects the local architecture', () => {
    for (const arch of ['arm64', 'x64']) {
      expect(platformAsset({ version: '2.9.7', files: macFiles }, '2.9.7', 'macos', arch)).toMatchObject({
        url: releaseBase('2.9.7') + 'TouShou-' + arch + '.zip', sha512
      })
    }
  })

  it('rejects manifests for another version or platform, external URLs, unsafe filenames and missing digests', () => {
    const metadata = { version: '2.9.8', files: macFiles }
    expect(() => platformAsset(metadata, '2.9.9', 'macos', 'x64')).toThrow()
    expect(() => platformAsset(metadata, '2.9.8', 'windows', 'x64')).toThrow()
    for (const file of [{ url: 'https://example.com/app.zip', sha512 }, { url: '../TouShou-x64.zip', sha512 }, { url: 'TouShou-x64.zip' }]) {
      expect(() => platformAsset({ ...metadata, files: [file] }, '2.9.8', 'macos', 'x64')).toThrow()
    }
  })
})
