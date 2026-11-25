import { constants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dialog } from 'electron'
import { DingTalkCliError } from './DingTalkCli'

async function destinationState(file: string) {
  try {
    const stat = await lstat(file, { bigint: true })
    if (!stat.isFile()) throw new DingTalkCliError('write-failed')
    return [stat.dev, stat.ino, stat.ctimeNs, stat.size].join(':')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Only the native dialog supplies local paths. DWS works on a private staged file. */
export async function withDingTalkTransfer(
  operation: string, flag: 'file' | 'output', signal: AbortSignal | undefined,
  dispatch: (stagedPath: string) => Promise<unknown>, canPublish?: () => boolean
): Promise<unknown> {
  signal?.throwIfAborted()
  if (flag === 'file') {
    const choice = await dialog.showOpenDialog({ title: '选择要上传到钉钉的文件', properties: ['openFile'] })
    if (choice.canceled || !choice.filePaths[0]) throw new DingTalkCliError('cancelled')
    signal?.throwIfAborted()
    const selected = await realpath(choice.filePaths[0])
    const staging = await mkdtemp(path.join(tmpdir(), 'toushou-dws-upload-'))
    try {
      const snapshot = path.join(staging, path.basename(selected))
      const input = await open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const before = await input.stat({ bigint: true })
        if (!before.isFile()) throw new DingTalkCliError('write-failed')
        const output = await open(snapshot, 'wx', 0o600)
        try {
          const buffer = Buffer.allocUnsafe(256 * 1024)
          let remaining = before.size
          while (remaining > 0n) {
            signal?.throwIfAborted()
            const size = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length))
            const { bytesRead } = await input.read(buffer, 0, size)
            if (!bytesRead) throw new DingTalkCliError('write-failed')
            await output.writeFile(buffer.subarray(0, bytesRead))
            remaining -= BigInt(bytesRead)
          }
        } finally { await output.close() }
        const after = await input.stat({ bigint: true })
        if (after.size !== before.size || after.mtimeNs !== before.mtimeNs) throw new DingTalkCliError('write-failed')
      } finally { await input.close() }
      signal?.throwIfAborted()
      return await dispatch(snapshot)
    } finally { await rm(staging, { recursive: true, force: true }).catch(() => {}) }
  }

  const save = await dialog.showSaveDialog({
    title: '保存钉钉文件',
    defaultPath: ({ 'sheet.export': '钉钉表格.xlsx', 'sheet.export-csv': '钉钉表格.csv' } as Record<string, string>)[operation] ?? '钉钉附件'
  })
  if (save.canceled || !save.filePath) throw new DingTalkCliError('cancelled')
  signal?.throwIfAborted()
  const destination = save.filePath
  const initial = await destinationState(destination)
  // Stage on the destination volume so publishing a successful download is atomic.
  const staging = await mkdtemp(path.join(path.dirname(destination), '.toushou-dws-download-'))
  try {
    const mail = operation === 'mail.attachment.download'
    const output = path.join(staging, mail ? 'attachment.bin' : path.basename(destination))
    await dispatch(mail ? staging : output)
    signal?.throwIfAborted()
    if (!(await lstat(output)).isFile() || await destinationState(destination) !== initial) {
      throw new DingTalkCliError('write-failed')
    }
    signal?.throwIfAborted()
    if (canPublish && !canPublish()) throw new DingTalkCliError('permission-denied')
    await rename(output, destination)
    return { saved: true }
  } finally { await rm(staging, { recursive: true, force: true }).catch(() => {}) }
}
