import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, rename, link, stat, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { chatAttachment } from '../../shared/chatAttachment'
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') }, dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true })), showSaveDialog: vi.fn() } }))
import { shell, dialog } from 'electron'
import { handleChatAttachment, transcriptReferencesFile } from '../chatAttachment'

describe('chat attachments', () => {
  it('recognizes local, cloud and web files without accepting launch instructions', () => {
    expect(chatAttachment('sandbox:/mnt/data/%E6%8A%A5%E5%91%8A.mp4')).toMatchObject({ name: '报告.mp4', kind: 'video', sandbox: true })
    expect(chatAttachment('https://example.com/data.csv?v=1')).toMatchObject({ kind: 'xlsx', remote: true })
    expect(chatAttachment('C:\\Reports\\review.pptx')).toMatchObject({ kind: 'pptx' })
    for (const raw of ['report.exe', '../outside.pdf', '//server/f.pdf', 'file://server/f.pdf', 'javascript:test.pdf', 'app.lnk']) expect(chatAttachment(raw)).toBeNull()
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
