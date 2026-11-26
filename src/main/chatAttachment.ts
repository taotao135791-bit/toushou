import path from 'node:path'
import { homedir } from 'node:os'
import { constants, promises as fs, type BigIntStats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { dialog, shell } from 'electron'
import { chatAttachment } from '../shared/chatAttachment'
import { replyAttachmentPaths } from '../shared/replyAttachmentPaths'
import { FsGuard } from './fsGuard'

interface AttachmentDownloads {
  directory: string
  isReferenced: (target: string, kind: 'file' | 'folder') => Promise<boolean>
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

function absoluteAttachmentPath(target: string): string | undefined {
  if (/^~[\\/]/.test(target)) return path.resolve(homedir(), target.slice(2))
  return path.isAbsolute(target) ? path.resolve(target) : undefined
}

export async function transcriptReferencesAttachment(
  messages: Array<{ role: string; content: string }> | null, target: string, kind: 'file' | 'folder'
): Promise<boolean> {
  const absolute = absoluteAttachmentPath(target)
  if (!messages || !absolute) return false
  if (kind === 'file' && transcriptReferencesFile(messages, target)) return true
  const basename = path.basename(absolute)
  const name = process.platform === 'win32' ? basename.toLowerCase() : basename
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const text = process.platform === 'win32' ? message.content.toLowerCase() : message.content
    // Markdown links can mix literal and percent-encoded characters in the same filename.
    if (!text.includes(name) && !/%[a-f\d]{2}/i.test(text)) continue
    // Resolve directory and filenames inside ONE reply. Never borrow a folder from another turn.
    const refs = await replyAttachmentPaths(message.content)
    for (const ref of kind === 'folder' ? refs.folders : refs.files) {
      const referenced = absoluteAttachmentPath(ref)
      if (referenced && path.relative(referenced, absolute) === '') return true
    }
  }
  return false
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs
}

interface SavedAttachmentCopy {
  destination: string
  identity: BigIntStats
  sourceIdentity: BigIntStats
}

interface RememberedAttachmentCopy extends SavedAttachmentCopy {
  source: string
}

// A successful native Save As grants access to that copy for this conversation
// while the app is running. Never share a remembered destination between sessions.
const rememberedAttachmentCopies = new Map<string, RememberedAttachmentCopy>()

async function statAttachmentIfPresent(target: string, followLink: boolean): Promise<BigIntStats | null> {
  try {
    return followLink ? await fs.stat(target, { bigint: true }) : await fs.lstat(target, { bigint: true })
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

async function findRememberedCopy(key: string): Promise<string | undefined> {
  const copy = rememberedAttachmentCopies.get(key)
  if (!copy) return
  const destination = await statAttachmentIfPresent(copy.destination, false).catch(() => null)
  const canonical = await fs.realpath(copy.destination).catch(() => undefined)
  if (destination?.isFile() && sameFile(destination, copy.identity) && canonical && path.relative(copy.destination, canonical) === '') {
    // The user may still need their copy after the original was moved. If that
    // name now points to a new revision, let the normal source lookup open it.
    const source = await statAttachmentIfPresent(copy.source, true).catch(() => undefined)
    if (source === null || (source?.isFile() && sameFile(source, copy.sourceIdentity)
        && source.size === copy.sourceIdentity.size && source.mtimeNs === copy.sourceIdentity.mtimeNs)) return copy.destination
  }
  if (rememberedAttachmentCopies.get(key) === copy) rememberedAttachmentCopies.delete(key)
}

async function openAttachmentFile(target: string, reveal: boolean): Promise<'ok' | 'unavailable'> {
  if (reveal) {
    shell.showItemInFolder(target)
    return 'ok'
  }
  return await shell.openPath(target) === '' ? 'ok' : 'unavailable'
}

async function saveAttachment(source: string, name: string, ext: string, expected: BigIntStats): Promise<'ok' | 'cancelled' | 'unavailable' | SavedAttachmentCopy> {
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = await input.stat({ bigint: true })
    if (!opened.isFile() || !sameFile(opened, expected) || path.relative(source, await fs.realpath(source)) !== '') return 'unavailable'
    const save = await dialog.showSaveDialog({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
    if (save.canceled || !save.filePath) return 'cancelled'
    if (path.extname(save.filePath).slice(1).toLowerCase() !== ext) return 'unavailable'
    const destination = path.join(await fs.realpath(path.dirname(save.filePath)), path.basename(save.filePath))
    const existing = await statAttachmentIfPresent(destination, true)
    if (existing && sameFile(existing, opened)) return { destination, identity: existing, sourceIdentity: opened }
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
      const identity = await output.stat({ bigint: true })
      await output.close()
      const after = await input.stat({ bigint: true })
      if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) return 'unavailable'
      const current = await statAttachmentIfPresent(destination, true)
      if (current && sameFile(current, opened)) return { destination, identity: current, sourceIdentity: opened }
      if (existing ? !current || !sameFile(existing, current) || existing.ctimeNs !== current.ctimeNs : current) return 'unavailable'
      await fs.rename(temp, destination)
      // Windows can preserve the creation time of an overwritten destination.
      // Take the published identity only when it still points to the staged file.
      const published = await statAttachmentIfPresent(destination, false).catch(() => null)
      return published?.isFile() && published.dev === identity.dev && published.ino === identity.ino
        ? { destination, identity: published, sourceIdentity: opened }
        : 'ok'
    } finally {
      await output.close()
      await fs.unlink(temp).catch(() => {})
    }
  } finally { await input.close() }
}

async function grantedSource(workspace: string, target: string, candidate: string, downloads?: AttachmentDownloads, kind: 'file' | 'referenced-folder' = 'file') {
  const source = await fs.realpath(candidate).catch(() => undefined)
  if (!source) return undefined
  const guard = new FsGuard()
  guard.addRoot(workspace)
  if (guard.isAllowed(source)) return source
  if (!downloads?.directory || !absoluteAttachmentPath(target)) return undefined
  const downloadsRoot = await fs.realpath(downloads.directory).catch(() => undefined)
  if (!downloadsRoot) return undefined
  const base = candidate === downloadsRoot || candidate.startsWith(downloadsRoot + path.sep) ? downloadsRoot : downloads.directory
  const inside = path.relative(base, candidate)
  if (path.isAbsolute(inside) || inside === '..' || inside.startsWith('..' + path.sep)) return undefined
  // An allowed Downloads spelling must identify this item, not an unrelated symlink destination.
  if (path.relative(path.join(downloadsRoot, inside), source) !== '') return undefined
  return (kind === 'referenced-folder' || await downloads.isReferenced(target, 'file')) ? source : undefined
}

export async function handleChatAttachment(workspace: string, raw: unknown, action: unknown, downloads?: AttachmentDownloads, sessionScope?: string) {
  const file = chatAttachment(raw)
  if (!file || file.remote || (action !== 'open' && action !== 'save' && action !== 'reveal')) return 'unavailable'
  try {
    const candidate = absoluteAttachmentPath(file.target) ?? path.resolve(workspace, file.target)
    const copyKey = sessionScope && JSON.stringify([workspace, sessionScope, file.sandbox ? file.target : candidate])
    const reveal = action === 'reveal' || file.revealOnly
    if (copyKey && action !== 'save') {
      const copy = await findRememberedCopy(copyKey)
      if (copy) return await openAttachmentFile(copy, reveal)
    }

    const granted = file.sandbox ? undefined : await grantedSource(workspace, file.target, candidate, downloads)
    let source = granted
    if (!source) {
      const selected = await dialog.showOpenDialog({
        title: '选择附件 · ' + file.name,
        defaultPath: file.sandbox ? file.name : candidate,
        properties: ['openFile'], filters: [{ name: file.ext.toUpperCase(), extensions: [file.ext] }]
      })
      if (selected.canceled || !selected.filePaths[0]) return 'cancelled'
      if (!file.sandbox && path.relative(path.join(path.dirname(selected.filePaths[0]), file.name), selected.filePaths[0]) !== '') return 'unavailable'
      source = await fs.realpath(selected.filePaths[0])
    }
    if (path.extname(source).slice(1).toLowerCase() !== file.ext) return 'unavailable'
    const expected = await fs.stat(source, { bigint: true })
    if (!expected.isFile() || path.relative(source, await fs.realpath(source)) !== '') return 'unavailable'
    if (action !== 'save') return await openAttachmentFile(source, reveal)
    const saved = await saveAttachment(source, file.name, file.ext, expected)
    if (typeof saved === 'string') {
      if (saved === 'ok' && copyKey) rememberedAttachmentCopies.delete(copyKey)
      return saved
    }
    if (copyKey) rememberedAttachmentCopies.set(copyKey, { ...saved, source: granted ? candidate : source })
    return 'ok'
  } catch { return 'unavailable' }
}

export async function openChatAttachmentFolder(workspace: string, raw: unknown, downloads: AttachmentDownloads): Promise<'ok' | 'unavailable'> {
  if (typeof raw !== 'string' || raw.length > 4096
      || /^[\\/]{2}|[\x00-\x1f\x7f]/.test(raw) || raw.split(/[\\/]/).includes('..')
      || raw.replace(/^[a-z]:[\\/]/i, '').includes(':')) return 'unavailable'
  try {
    const directory = absoluteAttachmentPath(raw)
    if (!directory || !await downloads.isReferenced(raw, 'folder')) return 'unavailable'
    let source = await grantedSource(workspace, raw, directory, downloads, 'referenced-folder')
    if (!source) {
      const selected = await dialog.showOpenDialog({
        title: '选择回复中的文件夹 · ' + path.basename(directory), defaultPath: directory, properties: ['openDirectory']
      })
      if (selected.canceled || !selected.filePaths[0]) return 'unavailable'
      source = await fs.realpath(selected.filePaths[0])
      if (path.relative(source, await fs.realpath(directory)) !== '') return 'unavailable'
    }
    if (!(await fs.stat(source)).isDirectory() || path.relative(source, await fs.realpath(source)) !== '') return 'unavailable'
    // Opening a macOS bundle via its default handler would launch it. Address Finder explicitly.
    if (process.platform === 'darwin') {
      return await new Promise(resolve => execFile('/usr/bin/open', ['-a', '/System/Library/CoreServices/Finder.app', source],
        { timeout: 10_000 }, error => resolve(error ? 'unavailable' : 'ok')))
    }
    if (process.platform === 'win32' && /\.\{[a-f\d-]{36}\}(?:[\\/]|$)/i.test(source)) return 'unavailable'
    return await shell.openPath(source) === '' ? 'ok' : 'unavailable'
  } catch { return 'unavailable' }
}
