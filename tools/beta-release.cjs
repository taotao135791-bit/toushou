// Beta-only packaging and artifact verification. No network or publication.
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')
const { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const config = require('../electron-builder.beta.cjs')
const version = config.extraMetadata.version
const tag = `beta-v${version}`
const root = path.resolve(__dirname, '..')

function validateConfig() {
  if (!/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(version)) throw new Error('Expected a beta version')
  if (config.appId !== 'com.toushou.desktop.beta' || config.productName !== '投手 Beta' || config.extraMetadata.name !== 'toushou-beta' || config.extraMetadata.main !== 'dist-electron/main/beta.cjs') throw new Error('Beta identity or entry is not isolated')
  if (config.generateUpdatesFilesForAllChannels !== false || config.publish.length !== 1 || config.publish[0].channel !== 'beta' || config.publish[0].releaseType !== 'prerelease') throw new Error('Beta update channel is not isolated')
  return { version, tag }
}

function validateRef(type, name) {
  validateConfig()
  if (type !== 'tag' || name !== tag) throw new Error(`Expected immutable beta tag ${tag}`)
}

function expectedAssets(platform) {
  const prefix = `TouShou-Beta-${version}`
  if (platform === 'mac') return ['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].flatMap(extension => [`${prefix}-${arch}.${extension}`, `${prefix}-${arch}.${extension}.blockmap`])).concat('beta-mac.yml')
  if (platform === 'windows') return [`${prefix}-x64.exe`, `${prefix}-x64.exe.blockmap`, 'beta.yml']
  throw new Error('Unsupported beta platform')
}
const checksumName = platform => platform === 'mac' ? 'SHA256SUMS-beta-mac.txt' : 'SHA256SUMS-beta-windows.txt'
const digest = filename => createHash('sha256').update(readFileSync(filename)).digest('hex')

function verifyAssets(directory, platform) {
  validateConfig()
  const assets = expectedAssets(platform)
  if (readdirSync(directory).some(name => /^latest(?:[-.]|$)/i.test(name))) throw new Error('Stable update manifest must not appear in beta artifacts')
  for (const filename of assets) if (!statSync(path.join(directory, filename)).isFile() || !statSync(path.join(directory, filename)).size) throw new Error(`Missing or empty beta asset ${filename}`)
  const manifest = require('yaml').parse(readFileSync(path.join(directory, platform === 'mac' ? 'beta-mac.yml' : 'beta.yml'), 'utf8'))
  const archives = assets.filter(filename => /\.(zip|exe)$/.test(filename))
  if (manifest?.version !== version || !Array.isArray(manifest.files) || archives.some(filename => !manifest.files.some(item => item.url === filename && typeof item.sha512 === 'string' && item.sha512.length > 0 && Number.isSafeInteger(item.size) && item.size === statSync(path.join(directory, filename)).size))) throw new Error('Beta update manifest does not describe its actual archives')
  if (manifest.files.some(item => !assets.includes(item.url))) throw new Error('Beta update manifest references an unexpected asset')
  if (manifest.files.some(item => item.sha512 !== createHash('sha512').update(readFileSync(path.join(directory, item.url))).digest('base64'))) throw new Error('Beta update manifest SHA-512 mismatch')
  return assets
}

function stageAssets(directory, platform, destination) {
  const assets = verifyAssets(directory, platform)
  mkdirSync(destination, { recursive: true })
  for (const filename of assets) copyFileSync(path.join(directory, filename), path.join(destination, filename))
  writeFileSync(path.join(destination, checksumName(platform)), assets.slice().sort().map(filename => `${digest(path.join(destination, filename))}  ${filename}\n`).join(''))
  verifyChecksums(destination, platform)
}

function verifyChecksums(directory, platform) {
  const assets = verifyAssets(directory, platform)
  const lines = readFileSync(path.join(directory, checksumName(platform)), 'utf8').trim().split('\n')
  if (lines.length !== assets.length) throw new Error('Beta checksum coverage mismatch')
  for (const filename of assets) if (!lines.includes(`${digest(path.join(directory, filename))}  ${filename}`)) throw new Error(`Beta checksum mismatch ${filename}`)
}

function prepare() {
  validateConfig()
  const directory = path.join(root, 'dist-electron', 'main')
  if (!statSync(path.join(directory, 'index.js')).isFile()) throw new Error('Build the application before preparing beta')
  copyFileSync(path.join(root, 'build', 'beta-bootstrap.cjs'), path.join(directory, 'beta.cjs'))
}

function verifyPackage(resources) {
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const asar = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar')
  const archive = path.join(resources, 'app.asar')
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  for (const [field, value] of Object.entries(config.extraMetadata)) if (metadata[field] !== value) throw new Error(`Packaged beta metadata mismatch ${field}`)
  const actual = asar.extractFile(archive, config.extraMetadata.main)
  if (!actual.equals(readFileSync(path.join(root, 'build', 'beta-bootstrap.cjs')))) throw new Error('Packaged beta bootstrap mismatch')
  if (!asar.extractFile(archive, 'dist-electron/main/index.js').length) throw new Error('Packaged beta Main is absent')
}

module.exports = { validateConfig, validateRef, expectedAssets, verifyAssets, stageAssets, verifyChecksums, prepare, verifyPackage }
if (require.main === module) {
  const [command, first, second, third] = process.argv.slice(2)
  if (command === 'metadata') { validateConfig(); process.stdout.write(`version=${version}\ntag=${tag}\n`) }
  else if (command === 'verify-ref') validateRef(process.env.GITHUB_REF_TYPE, process.env.GITHUB_REF_NAME)
  else if (command === 'prepare') prepare()
  else if (command === 'stage') stageAssets(first, second, third)
  else if (command === 'verify') verifyChecksums(first, second)
  else if (command === 'verify-package') verifyPackage(first)
  else throw new Error('Expected beta metadata, verify-ref, prepare, stage, verify or verify-package')
}
