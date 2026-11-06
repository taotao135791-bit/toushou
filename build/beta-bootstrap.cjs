// Copied verbatim to dist-electron/main/beta.cjs by tools/beta-release.cjs.
// This runs before index.js imports any store, integration or runtime module.
const path = require('node:path')
const { mkdirSync } = require('node:fs')

function configureBeta(app, environment = process.env, argv = process.argv, makeDirectory = mkdirSync) {
  const overrides = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--user-data-dir=')) overrides.push(argv[index].slice('--user-data-dir='.length))
    else if (argv[index] === '--user-data-dir') overrides.push(argv[++index])
  }
  if (overrides.length > 1 || overrides.some(value => typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))) throw new Error('Beta profile override must be one absolute directory')
  const profile = overrides.length ? path.normalize(overrides[0]) : path.join(app.getPath('appData'), 'toushou')
  makeDirectory(profile, { recursive: true, mode: 0o700 })
  // The beta app shares the production workspace at the user's request.
  // Keep the same Electron name/single-instance profile before any imports.
  app.setName('toushou')
  app.setPath('userData', profile)
  environment.TOUSHOU_RELEASE_CHANNEL = 'beta'
  // Preserve the existing CLI profile/config and explicit smoke isolation.
  return { profile }
}

module.exports = { configureBeta }
if (require.main === module) {
  configureBeta(require('electron').app)
  require('./index.js')
}
