/* CI only: replace an installed Windows build with a new build of the same version. */
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } = require('node:fs')
const { rm } = require('node:fs/promises')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')

if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Same-version installer smoke is restricted to GitHub Actions Windows runners.')
}

class SmokeError extends Error {}
const fail = message => { throw new SmokeError(message) }
const inputs = process.argv.slice(2).map(value => path.resolve(value))
if (inputs.length !== 3 || inputs.some(file => !existsSync(file) || !statSync(file).isFile())) {
  fail('Expected original installer, replacement installer, and staged replacement app.asar.')
}
const [originalInstaller, replacementInstaller, expectedAsar] = inputs
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
const { extractFile } = appBuilderRequire('@electron/asar')
const config = require('../electron-builder.json')
if (config.appId !== 'com.toushou.desktop' || config.productName !== '投手') fail('Unexpected application identity.')
const metadata = file => JSON.parse(extractFile(file, 'package.json').toString('utf8'))
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const expected = metadata(expectedAsar)
if (expected.version !== '2.2.1' || !expected.name) fail('Expected the authorized same-version replacement.')

const root = mkdtempSync(path.join(os.tmpdir(), 'toushou-reinstall-smoke-'))
const installDirectory = path.join(root, 'installed')
const installedExecutable = path.join(installDirectory, `${config.productName}.exe`)
const installedAsar = path.join(installDirectory, 'resources', 'app.asar')
let profile, profileOwned = false, installerTimedOut = false

function runBounded(executable, args, milliseconds, label, inheritOutput = false) {
  return new Promise((resolve, reject) => {
    let settled = false, child
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve()
    }
    const timer = setTimeout(() => {
      // Only terminate the child created by this invocation, never a name/PID search.
      installerTimedOut = true
      try { child?.kill('SIGKILL') } catch { /* the disposable CI runner owns remaining cleanup */ }
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref()
      finish(new SmokeError(`${label} exceeded its deadline.`))
    }, milliseconds)
    try {
      child = spawn(executable, args, { stdio: inheritOutput ? 'inherit' : 'ignore', windowsHide: !inheritOutput })
      child.once('error', () => finish(new SmokeError(`${label} could not start.`)))
      child.once('exit', (code, signal) => finish(code === 0 && !signal ? null : new SmokeError(`${label} did not exit successfully.`)))
    } catch { finish(new SmokeError(`${label} could not start.`)) }
  })
}

async function install(installer, label) {
  // NSIS /D must be last. Do not pass --force-run: /S then leaves the app closed.
  await runBounded(installer, ['/S', '/currentuser', `/D=${installDirectory}`], 90_000, label)
  if (!existsSync(installedExecutable) || !existsSync(installedAsar)) fail(`${label} did not install into the private directory.`)
}

function seedProfile(appMetadata) {
  // Electron uses productName || name for its default userData directory. This
  // product does not call app.setName or override userData in production Main.
  const appName = appMetadata.productName || appMetadata.name
  if (typeof appName !== 'string' || !appName || appName === '.' || appName === '..' || /[\\/:\x00-\x1f]/.test(appName)) fail('Invalid packaged profile name.')
  const appData = process.env.APPDATA
  if (!appData || !path.isAbsolute(appData) || !statSync(appData).isDirectory()) fail('Runner APPDATA is unavailable.')
  profile = path.join(realpathSync(appData), appName)
  // Fail closed on any existing profile; never seed or remove someone else's data.
  if (existsSync(profile)) fail('A pre-existing profile prevents isolated installer validation.')
  mkdirSync(profile)
  profileOwned = true
  const fixtures = {
    'omp-gui-settings.json': { setupComplete: true, language: 'en' },
    'kanban-boards-v2.json': { schemaVersion: 2, boards: [{ id: 'synthetic-reinstall-board', name: 'Synthetic reinstall board', widgets: [], createdAt: 1000, updatedAt: 1000 }] },
    'windows-reissue-sentinel.json': { fixture: 'synthetic-only', version: '2.2.1', purpose: 'same-version-install-preservation' },
  }
  return Object.entries(fixtures).map(([name, value]) => {
    const file = path.join(profile, name)
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
    writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
    return { file, bytes }
  })
}

async function run() {
  console.log('[windows-reinstall] installing original public build silently')
  await install(originalInstaller, 'Original installation')
  const original = metadata(installedAsar)
  if (original.version !== expected.version || original.name !== expected.name || (original.productName || original.name) !== (expected.productName || expected.name)) fail('Original and replacement identities or versions differ.')
  const originalAsarSha256 = hash(installedAsar)
  const expectedAsarSha256 = hash(expectedAsar)
  if (originalAsarSha256 === expectedAsarSha256) fail('Replacement payload must differ from the original build.')
  const fixtures = seedProfile(original)
  console.log('[windows-reinstall] reinstalling replacement with the same version')
  await install(replacementInstaller, 'Same-version replacement installation')
  if (hash(installedAsar) !== expectedAsarSha256) fail('Installed replacement payload does not match the staged build.')
  const replacement = metadata(installedAsar)
  if (replacement.version !== original.version || replacement.name !== original.name) fail('Installed replacement identity or version changed.')
  if (fixtures.some(({ file, bytes }) => !existsSync(file) || !readFileSync(file).equals(bytes))) fail('Same-version installation did not preserve synthetic profile files.')
  // Exercise the installed binary against the existing smoke's separate private
  // profile, including real startup, save, restart, UI checks and process cleanup.
  await runBounded(process.execPath, [path.join(__dirname, 'release-smoke.cjs'), installedExecutable], 150_000, 'Installed replacement functional smoke', true)
  if (fixtures.some(({ file, bytes }) => !existsSync(file) || !readFileSync(file).equals(bytes))) fail('Installed smoke modified the default synthetic profile.')
  console.log(JSON.stringify({
    check: 'windows-same-version-reinstall', version: expected.version,
    originalAsarSha256, replacementAsarSha256: expectedAsarSha256,
    originalInstallerSha256: hash(originalInstaller), replacementInstallerSha256: hash(replacementInstaller),
    syntheticFilesPreserved: fixtures.length, installedFunctionalSmoke: 'passed',
  }))
}

run().catch(error => {
  process.exitCode = 1
  console.error(`[windows-reinstall] ${error instanceof SmokeError ? error.message : 'Unexpected filesystem, archive or process failure.'}`)
}).finally(async () => {
  // If an installer exceeded its bound, do not race unknown NSIS descendants.
  // The GitHub-hosted runner is disposable; never tree-kill unrelated processes.
  if (installerTimedOut) return
  try {
    if (profileOwned && profile && !lstatSync(profile).isSymbolicLink()) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    process.exitCode = 1
    console.error('[windows-reinstall] Owned test-directory cleanup failed.')
  }
})
