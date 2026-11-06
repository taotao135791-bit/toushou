// Test builds use a separate app identity, update channel and set of artifacts.
// beta-bootstrap explicitly shares the existing production workspace.
// Keep electron-builder.json and package.json on the published stable channel.
const stable = require('./electron-builder.json')
module.exports = {
  ...stable,
  // electron-builder concatenates inherited publish arrays. Copy the shared
  // packaging settings explicitly so no stable provider survives this override.
  extends: null,
  appId: 'com.toushou.desktop.beta',
  productName: '投手 Beta',
  artifactName: 'TouShou-Beta-${version}-${arch}.${ext}',
  directories: { output: 'release-beta' },
  extraMetadata: {
    name: 'toushou-beta',
    productName: '投手 Beta',
    version: '2.4.0-beta.1',
    main: 'dist-electron/main/beta.cjs'
  },
  detectUpdateChannel: true,
  generateUpdatesFilesForAllChannels: false,
  publish: [{ provider: 'github', owner: 'taotao135791-bit', repo: 'toushou', channel: 'beta', releaseType: 'prerelease' }],
  win: { ...stable.win, target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: { shortcutName: '投手 Beta' }
}
