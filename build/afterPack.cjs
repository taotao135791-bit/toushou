const { execFileSync } = require('node:child_process')
const { renameSync, writeFileSync, chmodSync } = require('node:fs')
const path = require('node:path')

/**
 * Two launch fixes for unsigned mac builds:
 *
 * 1. Ad-hoc re-sign. electron-builder leaves the stock Electron linker
 *    signature in place when no signing identity is configured, which yields a
 *    broken seal ("code has no resources but signature indicates they must be
 *    present") — LaunchServices then refuses to open the app.
 *
 * 2. ELECTRON_RUN_AS_NODE shim. Some dev environments export
 *    ELECTRON_RUN_AS_NODE=1 session-wide (launchctl setenv), which makes every
 *    Electron binary behave as plain Node and kills any app launched from
 *    Finder/`open`. A tiny wrapper as CFBundleExecutable scrubs the variable
 *    before exec'ing the real Electron binary.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const product = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${product}.app`)
  const macosDir = path.join(appPath, 'Contents', 'MacOS')
  const realBin = path.join(macosDir, product)
  const shimmedBin = path.join(macosDir, `${product}.bin`)

  renameSync(realBin, shimmedBin)
  const wrapper = [
    '#!/bin/sh',
    '# Scrub ELECTRON_RUN_AS_NODE so a poisoned session env cannot kill the app.',
    'unset ELECTRON_RUN_AS_NODE',
    `exec "$(dirname "$0")/${product}.bin" "$@"`,
    ''
  ].join('\n')
  writeFileSync(realBin, wrapper, { mode: 0o755 })
  chmodSync(realBin, 0o755)

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
