import { dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import {
  OfficeOpenDialogResult,
  OfficeReadResult,
  OfficeSaveDialogResult,
  OfficeSaveResult,
  sanitizeOfficeSnapshot,
  sheetJsToUniver,
  univerToSheetJs
} from '../shared/officeWorkbook'
import { getOperationGrantManager } from './operationGrant'

/**
 * Office panel file bridge. Every read/write goes through a one-shot FileGrant
 * minted by Main (native dialog pick, or a validated extension open_panel
 * request) — a raw path never crosses in from the renderer. Writes are atomic
 * (tmp + rename, same as boards.ts). Fidelity limits of the conversion live
 * in shared/officeWorkbook.ts.
 */

export const OFFICE_FILE_MAX_BYTES = 20 * 1024 * 1024
export const OFFICE_SNAPSHOT_MAX_JSON_BYTES = 30 * 1024 * 1024
export const OFFICE_FILE_EXTENSIONS = ['xlsx', 'xls', 'csv'] as const
const OFFICE_SAVE_EXTENSIONS = ['xlsx', 'csv'] as const

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/

function isOfficeExtension(ext: string): boolean {
  return (OFFICE_FILE_EXTENSIONS as readonly string[]).includes(ext)
}

function extensionOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase()
}

/**
 * Validate an extension-supplied path for the office panel (open_panel flow):
 * realpath, must exist and be a regular file, supported extension, ≤ 20 MB.
 * Resolves the canonical real path, or null when any check fails.
 */
export async function validateOfficePath(candidate: unknown): Promise<string | null> {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate.length > 1024 ||
    CONTROL_RE.test(candidate)
  ) {
    return null
  }
  if (!isOfficeExtension(extensionOf(candidate))) return null
  try {
    const realPath = await fs.promises.realpath(path.resolve(candidate))
    const stat = await fs.promises.stat(realPath)
    if (!stat.isFile() || stat.size > OFFICE_FILE_MAX_BYTES) return null
    // Paranoia: the extension check applies to the resolved path as well, so a
    // misleadingly-named symlink cannot launder a different file type.
    if (!isOfficeExtension(extensionOf(realPath))) return null
    return realPath
  } catch {
    return null
  }
}

/** Native open dialog → one read grant; null when the user cancels. */
export async function officeOpenDialog(ownerWebContentsId: number): Promise<OfficeOpenDialogResult | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Excel / CSV', extensions: [...OFFICE_FILE_EXTENSIONS] }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  const grant = await getOperationGrantManager().mintOfficeFile(result.filePaths[0], ownerWebContentsId)
  return grant ? { grant, name: grant.name } : null
}

/** Consume-side read: parse the granted file into a bounded workbook snapshot. */
export async function readOfficeWorkbook(realPath: string): Promise<OfficeReadResult> {
  const name = path.basename(realPath)
  let buffer: Buffer
  try {
    const stat = await fs.promises.stat(realPath)
    if (stat.size > OFFICE_FILE_MAX_BYTES) return { ok: false, error: 'file-too-large' }
    buffer = await fs.promises.readFile(realPath)
  } catch {
    return { ok: false, error: 'read-failed' }
  }
  try {
    const ext = extensionOf(realPath)
    const wb =
      ext === 'csv'
        ? XLSX.read(buffer.toString('utf-8').replace(/^\uFEFF/, ''), { type: 'string', cellDates: true })
        : XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const { snapshot, warnings } = sheetJsToUniver(wb)
    snapshot.name = name
    return { ok: true, name, snapshot, warnings }
  } catch (err) {
    return { ok: false, error: 'parse-failed', detail: err instanceof Error ? err.message : String(err) }
  }
}

function sanitizeDefaultName(value: unknown): string {
  if (typeof value !== 'string') return 'workbook.xlsx'
  const cleaned = value.replace(CONTROL_RE, '').trim().slice(0, 200)
  return cleaned || 'workbook.xlsx'
}

/** Native save-as dialog → one write grant; null when the user cancels. */
export async function officeSaveDialog(
  defaultName: unknown,
  ownerWebContentsId: number
): Promise<OfficeSaveDialogResult | null> {
  const result = await dialog.showSaveDialog({
    defaultPath: sanitizeDefaultName(defaultName),
    filters: [
      { name: 'Excel Workbook', extensions: ['xlsx'] },
      { name: 'CSV', extensions: ['csv'] }
    ]
  })
  if (result.canceled || !result.filePath) return null
  // The user's dialog confirmation IS the authorization; Main only normalizes
  // the target to a writable office extension before minting the grant.
  let target = result.filePath
  const ext = extensionOf(target)
  if (!(OFFICE_SAVE_EXTENSIONS as readonly string[]).includes(ext)) {
    target = `${target}.xlsx`
  }
  const grant = await getOperationGrantManager().mintOfficeSaveTarget(target, ownerWebContentsId)
  return grant ? { grant, name: grant.name } : null
}

/** Consume-side write: snapshot → xlsx/csv buffer → atomic tmp + rename. */
export async function saveOfficeWorkbook(targetPath: string, rawSnapshot: unknown): Promise<OfficeSaveResult> {
  let jsonSize: number
  try {
    jsonSize = JSON.stringify(rawSnapshot)?.length ?? 0
  } catch {
    return { ok: false, error: 'invalid-snapshot' }
  }
  if (jsonSize > OFFICE_SNAPSHOT_MAX_JSON_BYTES) return { ok: false, error: 'snapshot-too-large' }
  const parsed = sanitizeOfficeSnapshot(rawSnapshot)
  if (!parsed) return { ok: false, error: 'invalid-snapshot' }
  try {
    const wb = univerToSheetJs(parsed.snapshot)
    const bookType = extensionOf(targetPath) === 'csv' ? 'csv' : 'xlsx'
    const out = XLSX.write(wb, { type: 'buffer', bookType }) as Buffer
    const tmp = `${targetPath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, out)
    fs.renameSync(tmp, targetPath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: 'write-failed', detail: err instanceof Error ? err.message : String(err) }
  }
}
