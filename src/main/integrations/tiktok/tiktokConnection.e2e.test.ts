import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

function electronBinary(): string | null {
  try {
    const root = path.dirname(require_.resolve('electron/package.json'))
    const executable = process.platform === 'win32' ? path.join(root, 'dist', 'electron.exe')
      : process.platform === 'darwin' ? path.join(root, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : path.join(root, 'dist', 'electron')
    return existsSync(executable) ? executable : null
  } catch { return null }
}

function bundleModules(dir: string): void {
  type Builder = { buildSync(options: Record<string, unknown>): unknown }
  let esbuild: Builder
  try { esbuild = require_('esbuild') as Builder }
  catch { esbuild = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) as Builder }
  esbuild.buildSync({
    stdin: {
      contents: [
        "export { TikTokAdsConnectionManager } from './TikTokAdsConnectionManager'",
        "export { TikTokCredentialStore } from './TikTokCredentialStore'",
        "export { TikTokRefreshService } from './TikTokRefreshService'",
        "export { setTikTokOAuthCredentialLoader } from './resolveTikTokToken'",
        "export { testMcpConnection } from '../mcp/McpConnectionStore'"
      ].join('\n'),
      resolveDir: __dirname, sourcefile: 'tiktok-connection-fixture.ts', loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(dir, 'modules.cjs')
  })
}

describe('TikTok connection e2e (isolated synthetic Electron)', () => {
  it('preserves pending OAuth on unrelated callbacks and uses a full real HTTP MCP session', { timeout: 45_000 }, () => {
    const binary = electronBinary()
    if (!binary) {
      if (process.env.TOUSHOU_E2E_REQUIRED === '1') throw new Error('TikTok connection e2e requires Electron')
      console.warn('[TikTok connection e2e] skipped (Electron binary unavailable)')
      return
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tiktok-connection-e2e-'))
    try {
      bundleModules(dir)
      const privateHome = path.join(dir, 'home')
      mkdirSync(privateHome, { recursive: true, mode: 0o700 })
      // Do not inherit provider keys, proxies or OMP configuration from the contributor.
      const env: NodeJS.ProcessEnv = {}
      for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'DISPLAY', 'LANG', 'LC_ALL']) {
        if (process.env[key]) env[key] = process.env[key]
      }
      env.HOME = process.platform === 'darwin' ? process.env.HOME : privateHome
      env.CFFIXED_USER_HOME = env.USERPROFILE = privateHome
      env.APPDATA = env.LOCALAPPDATA = env.XDG_CONFIG_HOME = env.XDG_CACHE_HOME = env.XDG_DATA_HOME = privateHome
      env.TMPDIR = env.TMP = env.TEMP = path.join(dir, 'tmp')
      mkdirSync(env.TEMP, { recursive: true, mode: 0o700 })
      env.PI_CODING_AGENT_DIR = path.join(privateHome, 'omp', 'agent')
      env.NO_PROXY = '127.0.0.1,localhost'
      const harness = path.resolve(__dirname, '../../../../test/tiktok-connection-harness.cjs')
      const result = spawnSync(binary, [harness, dir], { encoding: 'utf8', timeout: 30_000, env })
      expect(result.status, 'Synthetic Electron connection fixture did not exit successfully').toBe(0)
      const line = (result.stdout ?? '').split('\n').find(item => item.startsWith('E2E_RESULT '))
      expect(line, `Fixture returned no result: ${(result.stderr ?? '').slice(0, 500)}`).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data).not.toHaveProperty('fatal')
      expect(data).toMatchObject({
        unrelatedCallbacksPreserved: true,
        oauthConnected: true,
        oauthOnlyStatusConfigured: true,
        statusDidNotLoadCredentials: true,
        mcpHandshakeAndPagination: true,
        mcpFailureRejected: true,
        businessToolsCalled: false,
        nativeKeychainUsed: false
      })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
