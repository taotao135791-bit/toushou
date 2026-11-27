import { BrowserWindow, dialog } from 'electron'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { FEISHU_MAX_ATTACHMENT_BYTES } from './FeishuDocumentTools'

function sameVersion(previous: BigIntStats, current: BigIntStats): boolean {
  return current.isFile() && previous.dev === current.dev && previous.ino === current.ino
    && previous.birthtimeNs === current.birthtimeNs && previous.ctimeNs === current.ctimeNs
    && previous.mtimeNs === current.mtimeNs && previous.size === current.size
}

/** The user's native selection is the only local file this action can read. */
export async function pickFeishuAttachment(
  documentId: string,
  stillAllowed: () => boolean,
  signal?: AbortSignal
): Promise<{ name: string; bytes: Buffer } | null> {
  const win = BrowserWindow.getFocusedWindow()
  if (!win || win.isDestroyed() || signal?.aborted || !stillAllowed()) return null
  const selection = await dialog.showOpenDialog(win, {
    title: '选择并上传附件到飞书文档 ' + documentId,
    buttonLabel: '选择并上传',
    properties: ['openFile']
  })
  const selected = selection.filePaths[0]
  if (selection.canceled || !selected || win.isDestroyed() || signal?.aborted || !stillAllowed()) return null

  try {
    const before = await lstat(selected, { bigint: true })
    if (!before.isFile() || before.size < 1n || before.size > BigInt(FEISHU_MAX_ATTACHMENT_BYTES)) throw new Error()
    const canonical = await realpath(selected)
    if (signal?.aborted || !stillAllowed()) return null
    const input = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      if (!sameVersion(before, await input.stat({ bigint: true }))) throw new Error()
      const bytes = Buffer.alloc(Number(before.size))
      for (let offset = 0; offset < bytes.length;) {
        if (signal?.aborted || !stillAllowed()) return null
        const { bytesRead } = await input.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) throw new Error()
        offset += bytesRead
      }
      if (!sameVersion(before, await input.stat({ bigint: true }))
          || !sameVersion(before, await lstat(selected, { bigint: true }))) throw new Error()
      if (win.isDestroyed() || signal?.aborted || !stillAllowed()) return null
      const name = path.basename(selected)
      if (!name || /[\x00-\x1f\x7f]/.test(name)) throw new Error()
      return { name, bytes }
    } finally {
      await input.close()
    }
  } catch {
    // Keep paths and filesystem diagnostics confined to Main.
    throw new Error('无法读取所选附件。请选择未被修改的普通文件，大小不超过 20 MB。')
  }
}
