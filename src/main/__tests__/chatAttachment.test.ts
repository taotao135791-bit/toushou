import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, rename, link, stat, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { chatAttachment } from '../../shared/chatAttachment'
const openInFinder = vi.hoisted(() => vi.fn((_cmd, _args, _opts, done) => done(null)))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile: openInFinder }))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }, dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true })), showSaveDialog: vi.fn() } }))
import { shell, dialog } from 'electron'
import { handleChatAttachment, openChatAttachmentFolder, transcriptReferencesAttachment, transcriptReferencesFile } from '../chatAttachment'

describe('chat attachments', () => {
  it('recognizes local, cloud and web files without accepting launch instructions', () => {
    expect(chatAttachment('sandbox:/mnt/data/%E6%8A%A5%E5%91%8A.mp4')).toMatchObject({ name: '报告.mp4', kind: 'video', sandbox: true })
    expect(chatAttachment('https://example.com/data.csv?v=1')).toMatchObject({ kind: 'xlsx', remote: true })
    expect(chatAttachment('客户周报.HTML')).toMatchObject({ kind: 'txt', revealOnly: true })
    expect(chatAttachment('https://example.com/guide.html')).toBeNull()
    expect(chatAttachment('C:\\Reports\\review.pptx')).toMatchObject({ kind: 'pptx' })
    for (const raw of ['report.exe', '../outside.pdf', '//server/f.pdf', 'file://server/f.pdf', 'javascript:test.pdf', 'app.lnk']) expect(chatAttachment(raw)).toBeNull()
  })

  it('binds delivery names to the explicit directory in that reply and reveals only the actual file', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'ts-delivery-dir-'))
    try {
      const project = path.join(base, 'project'), downloads = path.join(base, 'Downloads')
      const dated = path.join(downloads, 'nov-25'), other = path.join(downloads, 'nov-24')
      await Promise.all([mkdir(project), mkdir(dated, { recursive: true }), mkdir(other, { recursive: true })])
      const name = '示例周报.html'
      const file = path.join(dated, name), decoy = path.join(other, name)
      await Promise.all([writeFile(file, '<p>new</p>'), writeFile(decoy, '<p>old</p>')])
      const messages = [{ role: 'assistant', content: '周报 `' + name + '`。\n\n输出目录：`' + dated + '`' }]
      const grant = { directory: downloads, isReferenced: (target: string, kind: 'folder' | 'file') => transcriptReferencesAttachment(messages, target, kind) }
      expect(await grant.isReferenced(file, 'file')).toBe(true)
      expect(await grant.isReferenced(decoy, 'file')).toBe(false)
      expect(await grant.isReferenced(dated, 'folder')).toBe(true)
      expect(await transcriptReferencesAttachment([{ role: 'assistant', content:
        '[阅读](示例%20周报.html)\n\n输出目录：`' + dated + '`'
      }], path.join(dated, '示例 周报.html'), 'file')).toBe(true)
      expect(await transcriptReferencesAttachment([
        { role: 'assistant', content: '文件：`' + name + '`' },
        { role: 'assistant', content: '目录：`' + dated + '`' }
      ], file, 'file')).toBe(false)
      vi.mocked(shell.openPath).mockClear()
      vi.mocked(shell.showItemInFolder).mockClear()
      expect(await handleChatAttachment(project, file, 'open', grant)).toBe('ok')
      expect(await handleChatAttachment(project, file, 'reveal', grant)).toBe('ok')
      expect(shell.showItemInFolder).toHaveBeenCalledTimes(2)
      expect(path.basename(vi.mocked(shell.showItemInFolder).mock.calls[0][0])).toBe(name)
      expect(shell.openPath).not.toHaveBeenCalled()
      expect(await handleChatAttachment(project, decoy, 'reveal', grant)).toBe('cancelled')
      expect(await handleChatAttachment(project, path.join(dated, 'fig1.png'), 'reveal', grant)).toBe('cancelled')
      expect(shell.showItemInFolder).toHaveBeenCalledTimes(2)
      expect(await openChatAttachmentFolder(project, dated, grant)).toBe('ok')
      expect(await openChatAttachmentFolder(project, other, grant)).toBe('unavailable')
      expect(await openChatAttachmentFolder(project, file, grant)).toBe('unavailable')
      expect(await openChatAttachmentFolder(project, path.join(dated, '..', 'nov-24'), grant)).toBe('unavailable')
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  it('rejects a different selected filename and Downloads links outside the allowed directory', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'ts-reveal-links-'))
    try {
      const project = path.join(base, 'project'), downloads = path.join(base, 'Downloads')
      await Promise.all([mkdir(project), mkdir(downloads)])
      const unrelated = path.join(base, 'something-else.csv')
      await writeFile(unrelated, 'other')
      vi.mocked(shell.showItemInFolder).mockClear()
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [unrelated] })
      expect(await handleChatAttachment(project, path.join(downloads, 'report.csv'), 'reveal')).toBe('unavailable')
      const external = path.join(base, 'external')
      await mkdir(external)
      await symlink(external, path.join(downloads, 'delivery'), process.platform === 'win32' ? 'junction' : 'dir')
      const grant = { directory: downloads, isReferenced: async () => true }
      expect(await openChatAttachmentFolder(project, path.join(downloads, 'delivery'), grant)).toBe('unavailable')
      if (process.platform !== 'win32') {
        await symlink(unrelated, path.join(downloads, 'linked.csv'))
        expect(await handleChatAttachment(project, path.join(downloads, 'linked.csv'), 'reveal', grant)).toBe('cancelled')
      }
      expect(shell.showItemInFolder).not.toHaveBeenCalled()
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  it('opens just the exact referenced folder selected in the native picker and preserves renamed sandbox copies', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'ts-explicit-folder-'))
    try {
      const project = path.join(base, 'project'), downloads = path.join(base, 'Downloads')
      const real = path.join(base, 'external', 'reports'), twin = path.join(base, 'other', 'reports')
      await Promise.all([project, downloads, real, twin].map(p => mkdir(p, { recursive: true })))
      const messages = [{ role: 'assistant', content: '输出目录：`' + real + '`' }]
      const grant = { directory: downloads, isReferenced: (target: string, kind: 'folder' | 'file') => transcriptReferencesAttachment(messages, target, kind) }
      vi.mocked(dialog.showOpenDialog).mockClear()
      expect(await openChatAttachmentFolder(project, twin, grant)).toBe('unavailable')
      expect(dialog.showOpenDialog).not.toHaveBeenCalled()
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [twin] })
      expect(await openChatAttachmentFolder(project, real, grant)).toBe('unavailable')
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [real] })
      expect(await openChatAttachmentFolder(project, real, grant)).toBe('ok')
      expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: real, properties: ['openDirectory'] }))

      const renamed = path.join(twin, 'renamed.pdf')
      await writeFile(renamed, '%PDF-1.4')
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [renamed] })
      expect(await handleChatAttachment(project, 'sandbox:/mnt/data/report.pdf', 'open', grant)).toBe('ok')
    } finally { await rm(base, { recursive: true, force: true }) }
  })
  it('opens a delivered download only for a matching transcript and download directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ts-delivery-'))
    try {
      const project = path.join(root, 'project')
      const downloads = path.join(root, 'Downloads')
      await Promise.all([mkdir(project), mkdir(downloads)])
      const file = path.join(downloads, '客户 Report 50%.csv')
      await writeFile(file, 'impressions,clicks')
      const messages = [{ role: 'assistant', content: '交付： `' + file + '`' }]
      const reference = (target: string) => Promise.resolve(transcriptReferencesFile(messages, target))
      expect(transcriptReferencesFile(messages, file.slice(0, -4))).toBe(false)
      const before = vi.mocked(shell.openPath).mock.calls.length
      expect(await handleChatAttachment(project, file, 'open', { directory: downloads, isReferenced: reference })).toBe('ok')
      expect(vi.mocked(shell.openPath).mock.calls.length).toBe(before + 1)
      expect(await handleChatAttachment(project, file, 'open', { directory: downloads, isReferenced: async () => false })).toBe('cancelled')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('saves the selected source revision when another report takes its name during the dialog', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ts-report-revision-'))
    const source = path.join(dir, 'report.csv'), dest = path.join(dir, 'saved.csv')
    try {
      const original = 'original,row\n'.repeat(40_000) // cross multiple read chunks
      await writeFile(source, original)
      await writeFile(dest, 'previous export')
      vi.mocked(dialog.showSaveDialog).mockImplementationOnce(async () => {
        await rename(source, path.join(dir, 'original.csv'))
        await writeFile(source, 'new revision')
        return { canceled: false, filePath: dest }
      })
      expect(await handleChatAttachment(dir, source, 'save')).toBe('ok')
      expect(await readFile(dest, 'utf8')).toBe(original)
      expect(await readFile(source, 'utf8')).toBe('new revision')

      vi.mocked(dialog.showSaveDialog).mockImplementationOnce(async () => {
        await writeFile(source, 'updated source in place')
        return { canceled: false, filePath: dest }
      })
      expect(await handleChatAttachment(dir, source, 'save')).toBe('unavailable')
      expect(await readFile(dest, 'utf8')).toBe(original)
      expect((await readdir(dir)).filter(file => file.startsWith('.toushou-'))).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('keeps the original inode and contents when saving to a hard link of the source', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ts-report-links-'))
    const source = path.join(dir, 'report.csv'), alias = path.join(dir, 'alias.csv')
    try {
      await writeFile(source, 'same file')
      await link(source, alias)
      const original = await stat(source, { bigint: true })
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: alias })
      expect(await handleChatAttachment(dir, source, 'save')).toBe('ok')
      expect(await readFile(alias, 'utf8')).toBe('same file')
      const after = await stat(alias, { bigint: true })
      expect([after.ino, after.dev, after.ctimeNs]).toEqual([original.ino, original.dev, original.ctimeNs])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('opens a workspace file, saves a separate copy, and requires selection outside the grant', async () => {
    vi.mocked(shell.openPath).mockClear()
    const root = await mkdtemp(path.join(os.tmpdir(), 'ts-attachment-'))
    const dir = path.join(root, 'project'), file = path.join(dir, 'report.csv'), dest = path.join(root, 'copy.csv')
    try {
      await mkdir(dir); await writeFile(file, 'a,b')
      expect(await handleChatAttachment(dir, './report.csv', 'open')).toBe('ok')
      expect(shell.openPath).toHaveBeenCalledTimes(1)
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({canceled:false, filePath:dest})
      expect(await handleChatAttachment(dir, file, 'save')).toBe('ok')
      expect(await readFile(dest, 'utf8')).toBe('a,b')
      expect(await handleChatAttachment(dir, dest, 'open')).toBe('cancelled')
      if (process.platform !== 'win32') {
        await symlink(dest, path.join(dir,'link.csv'))
        expect(await handleChatAttachment(dir, './link.csv', 'open')).toBe('cancelled')
      }
      expect(shell.openPath).toHaveBeenCalledTimes(1)
    } finally { await rm(root, {recursive:true, force:true}) }
  })
})
