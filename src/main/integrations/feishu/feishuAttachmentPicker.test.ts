import { writeFileSync } from 'node:fs'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  const win = { isDestroyed: vi.fn(() => false) }
  return { win, getFocusedWindow: vi.fn((): typeof win | null => win), showOpenDialog: vi.fn() }
})
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: native.getFocusedWindow },
  dialog: { showOpenDialog: native.showOpenDialog }
}))

import { FEISHU_MAX_ATTACHMENT_BYTES } from './FeishuDocumentTools'
import { pickFeishuAttachment } from './feishuAttachmentPicker'

beforeEach(() => {
  native.getFocusedWindow.mockReset().mockReturnValue(native.win)
  native.showOpenDialog.mockReset()
})

describe('native Feishu attachment picker', () => {
  it('returns only the file name and bytes chosen by the local user', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'feishu-picked-file-'))
    try {
      const selected = path.join(dir, '周报.csv')
      await writeFile(selected, 'clicks,12\n')
      native.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })
      expect(await pickFeishuAttachment('doc_selected', () => true)).toEqual({ name: '周报.csv', bytes: Buffer.from('clicks,12\n') })
      expect(native.showOpenDialog).toHaveBeenCalledWith(native.win, expect.objectContaining({
        title: expect.stringContaining('doc_selected'), properties: ['openFile']
      }))
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('does not open a picker without a live focused window and live approval', async () => {
    expect(await pickFeishuAttachment('doc_selected', () => false)).toBeNull()
    native.getFocusedWindow.mockReturnValue(null)
    expect(await pickFeishuAttachment('doc_selected', () => true)).toBeNull()
    expect(native.showOpenDialog).not.toHaveBeenCalled()
  })

  it('ignores a selection after the operation was cancelled or lost its authority', async () => {
    const controller = new AbortController()
    native.showOpenDialog.mockImplementationOnce(async () => {
      controller.abort()
      return { canceled: false, filePaths: ['/not-read-by-main'] }
    })
    expect(await pickFeishuAttachment('doc_selected', () => true, controller.signal)).toBeNull()
    let allowed = true
    native.showOpenDialog.mockImplementationOnce(async () => {
      allowed = false
      return { canceled: false, filePaths: ['/not-read-by-main'] }
    })
    expect(await pickFeishuAttachment('doc_selected', () => allowed)).toBeNull()
  })

  it('rejects empty and oversized files before reading', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'feishu-picked-file-limit-'))
    try {
      const selected = path.join(dir, 'sample.csv')
      await writeFile(selected, '')
      native.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })
      await expect(pickFeishuAttachment('doc_selected', () => true)).rejects.toThrow('无法读取所选附件')
      await truncate(selected, FEISHU_MAX_ATTACHMENT_BYTES + 1)
      await expect(pickFeishuAttachment('doc_selected', () => true)).rejects.toThrow('无法读取所选附件')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects a file modified while its selected version is being read', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'feishu-picked-file-changed-'))
    try {
      const selected = path.join(dir, 'sample.csv')
      await writeFile(selected, 'before')
      native.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })
      let checks = 0
      await expect(pickFeishuAttachment('doc_selected', () => {
        if (++checks === 4) writeFileSync(selected, 'a different revision')
        return true
      })).rejects.toThrow('无法读取所选附件')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
