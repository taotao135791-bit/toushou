/** Stable channels select immutable release tags. Neither the index nor a manifest supplies a host. */
export const stableIndexUrl = 'https://raw.githubusercontent.com/taotao135791-bit/toushou/release-channels/stable.json'
export const repositoryUrl = 'https://github.com/taotao135791-bit/toushou'

export type StablePlatform = 'macos' | 'windows'

export function stablePlatform(platform: NodeJS.Platform): StablePlatform | undefined {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return undefined
}

function isStableVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.split('.').every(part => Number.isSafeInteger(Number(part)))
}

export function pickStableVersion(json: string, platform: StablePlatform): string {
  const index: unknown = JSON.parse(json)
  if (!index || typeof index !== 'object' || Object.keys(index).length !== 3
      || !('schemaVersion' in index) || index.schemaVersion !== 1
      || !('macos' in index) || !isStableVersion(index.macos)
      || !('windows' in index) || !isStableVersion(index.windows)) {
    throw new Error('平台更新清单无效，请稍后重试。')
  }
  return platform === 'macos' ? index.macos : index.windows
}

export function releaseBase(version: string): string {
  if (!isStableVersion(version)) throw new Error('正式版本号无效。')
  return `${repositoryUrl}/releases/download/v${version}/`
}

export function platformAsset(metadata: unknown, version: string, platform: StablePlatform, arch: string) {
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || metadata.version !== version
      || 'packages' in metadata || !('files' in metadata) || !Array.isArray(metadata.files)) {
    throw new Error('更新包清单与该平台的发行版本不一致。')
  }
  if (platform === 'macos' && arch !== 'arm64' && arch !== 'x64') throw new Error('当前 Mac 架构没有更新包。')
  const expected = platform === 'windows' ? 'TouShou-x64.exe' : `TouShou-${arch}.zip`
  const allowed = platform === 'windows' ? /^TouShou-x64\.exe$/ : /^TouShou-(arm64|x64)\.(zip|dmg)$/
  const files: Array<{url: string; sha512: string; size?: number}> = metadata.files
  const names = new Set<string>()
  for (const file of files) {
    if (!file || typeof file.url !== 'string' || !allowed.test(file.url) || names.has(file.url)
        || typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) {
      throw new Error('平台更新包的文件名或 SHA-512 校验信息无效。')
    }
    names.add(file.url)
  }
  const asset = files.find(file => file.url === expected)
  if (!asset) throw new Error(`清单中没有找到 ${expected}。`)
  const size = typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : undefined
  return { version, fileName: expected, url: releaseBase(version) + expected, sha512: asset.sha512, size }
}
