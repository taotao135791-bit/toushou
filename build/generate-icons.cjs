// Export the existing main UI signal mark as desktop icons. Run on macOS.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const destination = path.join(root, 'build')
if (process.platform !== 'darwin') throw Error('Icon generation requires macOS sips and iconutil; other platforms use the committed assets.')
const source = fs.readFileSync(path.join(root, 'src/renderer/components/Logo.tsx'), 'utf8')
const pattern = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" fill="rgb\(var\(--accent(?:-deep)?\)\)"\s*\/>/g
const bars = [...source.matchAll(pattern)]
if (bars.length !== 3) throw Error('Expected exactly three bars from the main UI Logo component.')
// The light theme uses the same neutral mark for all three bars.
const shapes = bars.map(([, x, y, width, height, rx]) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="#202020"/>`).join('\n')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 24 24">\n<rect width="24" height="24" rx="5.28" fill="#f7f7f7"/>\n${shapes}\n</svg>\n`
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toushou-icon-'))
try {
  fs.writeFileSync(path.join(directory, 'icon.svg'), svg)
  execFileSync('sips', ['-s', 'format', 'png', path.join(directory, 'icon.svg'), '--out', path.join(directory, 'icon.png')], { stdio: 'ignore' })
  const iconset = path.join(directory, 'signal.iconset')
  fs.mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
    execFileSync('sips', ['-z', String(size * scale), String(size * scale), path.join(directory, 'icon.png'), '--out', path.join(iconset, name)], { stdio: 'ignore' })
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(directory, 'icon.icns')], { stdio: 'ignore' })
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const payloads = sizes.map(size => {
    const file = path.join(directory, `ico-${size}.png`)
    execFileSync('sips', ['-z', String(size), String(size), path.join(directory, 'icon.png'), '--out', file], { stdio: 'ignore' })
    return fs.readFileSync(file)
  })
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  payloads.forEach((png, index) => {
    const at = 6 + index * 16
    header[at] = sizes[index] === 256 ? 0 : sizes[index]
    header[at + 1] = header[at]
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([header, ...payloads]))
  fs.mkdirSync(destination, { recursive: true })
  for (const name of ['icon.svg', 'icon.png', 'icon.icns', 'icon.ico']) fs.copyFileSync(path.join(directory, name), path.join(destination, name))
  console.log('Exported the main UI signal logo to build/icon.svg, .png, .icns and .ico.')
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
