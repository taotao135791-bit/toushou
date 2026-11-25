import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dialog } from 'electron'
import { withDingTalkTransfer } from './workspaceFileTransfer'

vi.mock('electron', () => ({ app: {}, dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() } }))
let directory: string
beforeEach(async () => {
  vi.resetAllMocks()
  directory = await mkdtemp(path.join(tmpdir(), 'dws-test-transfer-'))
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

it('uploads only a snapshot of the file chosen by the user and cleans it up', async () => {
  const source = path.join(directory, '季度报表.csv')
  await writeFile(source, 'name,quantity\nDemo,21')
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [source] })
  let snapshot = ''
  const result = await withDingTalkTransfer('drive.upload', 'file', undefined, async staged => {
    snapshot = staged
    expect(staged).not.toBe(source)
    expect(path.basename(staged)).toBe('季度报表.csv')
    await writeFile(source, 'edited after selection')
    expect(await readFile(staged, 'utf8')).toContain('Demo,21')
    return { fileId: 'example' }
  })
  expect(result).toEqual({ fileId: 'example' })
  await expect(access(snapshot)).rejects.toThrow()
})

it('saves only the expected downloaded file, including an attachment returned by a directory-mode CLI', async () => {
  const destination = path.join(directory, 'my-attachment.pdf')
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: destination })
  expect(await withDingTalkTransfer('mail.attachment.download', 'output', undefined, async stagedDirectory => {
    await writeFile(path.join(stagedDirectory, 'attachment.bin'), 'sample PDF')
    return { output: stagedDirectory }
  })).toEqual({ saved: true })
  expect(await readFile(destination, 'utf8')).toBe('sample PDF')
})

it('preserves the selected destination on cancellation, failure and concurrent edits', async () => {
  const destination = path.join(directory, 'report.xlsx')
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: destination })
  await writeFile(destination, 'before')
  const run = (dispatch: (file: string) => Promise<unknown>) => withDingTalkTransfer('sheet.export', 'output', undefined, dispatch)
  await expect(run(async file => { await writeFile(file, 'partial'); throw Error('failed') })).rejects.toThrow()
  expect(await readFile(destination, 'utf8')).toBe('before')
  await expect(run(async file => { await writeFile(file, 'exported'); await writeFile(destination, 'external edit') })).rejects.toThrow()
  expect(await readFile(destination, 'utf8')).toBe('external edit')
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: '' })
  const dispatch = vi.fn()
  await expect(run(dispatch)).rejects.toMatchObject({ code: 'cancelled' })
  expect(dispatch).not.toHaveBeenCalled()
})
