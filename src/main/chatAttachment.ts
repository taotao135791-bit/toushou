import path from 'node:path'
import { homedir } from 'node:os'
import { constants, promises as fs, type BigIntStats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dialog, shell } from 'electron'
import { chatAttachment } from '../shared/chatAttachment'
import { FsGuard } from './fsGuard'

interface AttachmentDownloads {
  directory: string
  isReferenced: (file: string) => Promise<boolean>
}

/** Only recognize an exact file reference inside the selected transcript. */
export function transcriptReferencesFile(messages: Array<{ role: string; content: string }> | null, target: string): boolean {
  const spellings = [target, encodeURI(target), target.replace(/ /g, '%20')]
  return !!messages?.some(({ role, content }) => (role === 'user' || role === 'assistant') && spellings.some(spelling => {
    let from = 0
    while (from < content.length) {
      const index = content.indexOf(spelling, from)
      if (index < 0) return false
      from = index + spelling.length
      if ((index === 0 || /[\s`(<@]/.test(content[index - 1])) && (from === content.length || /[\s`)>]/.test(content[from]))) return true
    }
    return false
  }))
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs
}

async function saveAttachment(source: string, name: string, ext: string, expected: BigIntStats) {
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = await input.stat({ bigint: true })
    if (!opened.isFile() || !sameFile(opened, expected) || path.relative(source, await fs.realpath(source)) !== '') return 'unavailable'
    const save = await dialog.showSaveDialog({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
    if (save.canceled || !save.filePath) return 'cancelled'
    const destination = save.filePath
    if (path.extname(destination).slice(1).toLowerCase() !== ext) return 'unavailable'
    const statDestination = async () => fs.stat(destination, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    const existing = await statDestination()
    if (existing && sameFile(existing, opened)) return 'ok'
    if (existing && !existing.isFile()) return 'unavailable'

    // Stage beside the destination and publish only a complete, consistent copy.
    // Neither the source path nor an existing destination is reopened for writing.
    const temp = path.join(path.dirname(destination), '.toushou-' + randomUUID() + '.tmp')
    const output = await fs.open(temp, 'wx', 0o600)
    try {
      const buffer = Buffer.allocUnsafe(256 * 1024)
      let remaining = opened.size
      while (remaining > 0n) {
        const length = remaining < BigInt(buffer.length) ? Number(remaining) : buffer.length
        const { bytesRead } = await input.read(buffer, 0, length)
        if (!bytesRead) return 'unavailable'
        await output.writeFile(buffer.subarray(0, bytesRead))
        remaining -= BigInt(bytesRead)
      }
      await output.close()
      const after = await input.stat({ bigint: true })
      if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) return 'unavailable'
      const current = await statDestination()
      if (current && sameFile(current, opened)) return 'ok'
      if (existing ? !current || !sameFile(existing, current) || existing.ctimeNs !== current.ctimeNs : current) return 'unavailable'
      await fs.rename(temp, destination)
      return 'ok'
    } finally {
      await output.close()
      await fs.unlink(temp).catch(() => {})
    }
  } finally { await input.close() }
}

export async function handleChatAttachment(workspace: string, raw: unknown, action: unknown, downloads?: AttachmentDownloads) {
  const file = chatAttachment(raw)
  if (!file || file.remote || (action !== 'open' && action !== 'save')) return 'unavailable'
  try {
    const guard = new FsGuard()
    guard.addRoot(workspace)
    const candidate = /^~[\\/]/.test(file.target)
      ? path.resolve(homedir(), file.target.slice(2)) : path.resolve(workspace, file.target)
    let source = file.sandbox ? undefined : await fs.realpath(candidate).catch(() => undefined)
    if (source && !guard.isAllowed(source)) {
      // Only look up the transcript when the user opens a delivered file in Downloads.
      const allowed = downloads && path.isAbsolute(file.target) && downloads.directory
      const downloadGuard = new FsGuard()
      if (allowed) downloadGuard.addRoot(downloads.directory)
      if (!allowed || !downloadGuard.isAllowed(source) || !await downloads.isReferenced(file.target)) source = undefined
    }
    if (!source) {
      const selected = await dialog.showOpenDialog({
        title: '选择附件 · ' + file.name,
        defaultPath: file.sandbox ? file.name : candidate,
        properties: ['openFile'], filters: [{ name: file.ext.toUpperCase(), extensions: [file.ext] }]
      })
      if (selected.canceled || !selected.filePaths[0]) return 'cancelled'
      source = await fs.realpath(selected.filePaths[0])
    }
    if (path.extname(source).slice(1).toLowerCase() !== file.ext) return 'unavailable'
    const expected = await fs.stat(source, { bigint: true })
    if (!expected.isFile()) return 'unavailable'
    if (action === 'open') return await shell.openPath(source) === '' ? 'ok' : 'unavailable'
    return await saveAttachment(source, file.name, file.ext, expected)
  } catch { return 'unavailable' }
}
