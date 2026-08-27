import { spawn } from 'node:child_process'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { InstallStatus } from '../shared/types'

const INSTALL_SCRIPT_URL = 'https://omp.sh/install'

/** Upper bound on the installer script size (a real installer is tiny). */
const MAX_SCRIPT_BYTES = 1024 * 1024

/** Hosts the installer may be served from (or redirect to). */
const TRUSTED_HOSTS = new Set([
  'omp.sh',
  'www.omp.sh',
  'get.omp.sh',
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com'
])

/** A URL is trusted only when it is https AND on an allowed host (or subdomain). */
export function isTrustedUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return (
      TRUSTED_HOSTS.has(host) ||
      host.endsWith('.omp.sh') ||
      host.endsWith('.github.com') ||
      host.endsWith('.githubusercontent.com')
    )
  } catch {
    return false
  }
}

/** Environment passed to the remote installer: minimal, no credentials. */
const INSTALLER_ENV_KEYS = [
  'PATH',
  'HOME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'LOGNAME',
  'NO_COLOR',
  'FORCE_COLOR'
]

/** Build a minimal child env — never forward provider keys / tokens / AWS_* etc. */
function minimalInstallerEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of INSTALLER_ENV_KEYS) {
    if (process.env[key] !== undefined) out[key] = process.env[key]
  }
  out.PATH = '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:' + (process.env.PATH || '')
  return out
}

export async function installOmp(
  onStatus: (status: InstallStatus) => void
): Promise<boolean> {
  const platform = os.platform()

  if (platform === 'win32') {
    onStatus({
      type: 'error',
      message: 'Windows auto-install is not yet supported. Please run: irm https://omp.sh/install.ps1 | iex'
    })
    return false
  }

  onStatus({ type: 'downloading', progress: 0, message: 'Downloading installer...' })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-gui-install-'))
  const scriptPath = path.join(tmpDir, 'install.sh')

  try {
    await downloadFile(INSTALL_SCRIPT_URL, scriptPath, (progress) => {
      onStatus({ type: 'downloading', progress, message: `Downloading installer... ${progress.toFixed(0)}%` })
    })

    onStatus({ type: 'installing', message: 'Running installer (may require password)...' })

    return new Promise((resolve) => {
      const proc = spawn('sh', [scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: minimalInstallerEnv()
      })

      let output = ''

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        output += text
        const lastLine = text.trim().split('\n').pop() || ''
        onStatus({ type: 'installing', message: lastLine || 'Installing...' })
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        output += text
        const lastLine = text.trim().split('\n').pop() || ''
        onStatus({ type: 'installing', message: lastLine || 'Installing...' })
      })

      proc.on('close', (code) => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          // ignore cleanup errors
        }

        if (code === 0) {
          onStatus({ type: 'success' })
          resolve(true)
        } else {
          onStatus({
            type: 'error',
            message: `Install failed with code ${code}.\n${output.slice(-500)}`
          })
          resolve(false)
        }
      })
    })
  } catch (err) {
    onStatus({
      type: 'error',
      message: `Download failed: ${err instanceof Error ? err.message : String(err)}`
    })
    return false
  }
}

function downloadFile(
  url: string,
  dest: string,
  onProgress: (progress: number) => void,
  redirectsLeft = 5
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Trust boundary: only download from the allowlisted installer hosts.
    if (!isTrustedUrl(url)) {
      reject(new Error('Refusing to download from an untrusted host'))
      return
    }
    const file = fs.createWriteStream(dest)
    let downloaded = 0
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      file.destroy()
      try {
        fs.unlinkSync(dest)
      } catch {
        // already gone
      }
      reject(err)
    }
    https
      .get(url, (response) => {
        // Follow redirects manually — https.get does not follow them. Only to
        // trusted hosts, and only up to a bounded number of hops.
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume()
          file.destroy()
          try {
            fs.unlinkSync(dest)
          } catch {
            // already gone
          }
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'))
            return
          }
          if (!isTrustedUrl(response.headers.location)) {
            reject(new Error('Refusing to follow a redirect to an untrusted host'))
            return
          }
          resolve(
            downloadFile(response.headers.location, dest, onProgress, redirectsLeft - 1)
          )
          return
        }

        if (response.statusCode !== 200) {
          response.resume()
          fail(new Error(`HTTP ${response.statusCode}`))
          return
        }

        const total = parseInt(response.headers['content-length'] || '0', 10)
        if (total > MAX_SCRIPT_BYTES) {
          response.resume()
          fail(new Error('Installer script exceeds the size limit'))
          return
        }

        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (downloaded > MAX_SCRIPT_BYTES) {
            response.destroy()
            fail(new Error('Installer script exceeds the size limit'))
            return
          }
          if (total > 0) {
            onProgress((downloaded / total) * 100)
          }
        })

        response.pipe(file)
        file.on('finish', () => {
          file.close()
          resolve()
        })
      })
      .on('error', (err) => {
        fail(err)
      })
  })
}
