import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beginTaskDelivery, finishTaskDelivery, listTasks } from './scheduledTasks'
import { feishuConnectionManager } from './integrations/feishu/FeishuConnectionManager'

type Payload = { version: 1; taskId: string; runId: string; chatId: string; content: string }
const payloadRoot = () => path.join(app.getPath('userData'), 'task-delivery-outbox')
const payloadName = (taskId: string, runId: string) => `${createHash('sha256').update(JSON.stringify([taskId, runId])).digest('hex')}.json`
const payloadFile = (taskId: string, runId: string) => path.join(payloadRoot(), payloadName(taskId, runId))
const validChat = (chatId: unknown): chatId is string => typeof chatId === 'string' && /^oc_[A-Za-z0-9_-]{1,200}$/.test(chatId)

/** Local, Main-only retry material. Neither content nor the captured recipient
 * is accepted from Renderer or exposed by the task-list/broadcast API. */
function readPayload(taskId: string, runId: string): Payload | null {
  try {
    const file = payloadFile(taskId, runId), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_000) return null
    const value = JSON.parse(readFileSync(file, 'utf8')) as Payload
    return value?.version === 1 && value.taskId === taskId && value.runId === runId && validChat(value.chatId) &&
      typeof value.content === 'string' && value.content.length > 0 && value.content.length <= 3000 ? value : null
  } catch { return null }
}

function writePayload(payload: Payload): void {
  const root = payloadRoot(), file = payloadFile(payload.taskId, payload.runId)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const temporary = path.join(root, `${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const fd = openSync(temporary, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    // Retry material is immutable: a second caller cannot replace its target
    // or content, even if it arrives before the delivery ledger is claimed.
    try { linkSync(temporary, file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || JSON.stringify(readPayload(payload.taskId, payload.runId)) !== JSON.stringify(payload)) throw error
    }
    if (process.platform !== 'win32') {
      const directory = openSync(root, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  } finally { try { unlinkSync(temporary) } catch { /* already removed */ } }
}

/** Bound the outbox to the existing, bounded run ledgers. */
export function pruneTaskDeliveryPayloads(): void {
  const live = new Set(listTasks().flatMap(task => (task.runs ?? []).flatMap(run => run.runId ? [payloadName(task.id, run.runId)] : [])))
  try {
    for (const name of readdirSync(payloadRoot())) if (/^[a-f0-9]{64}\.json$/.test(name) && !live.has(name)) unlinkSync(path.join(payloadRoot(), name))
  } catch { /* cleanup never changes the execution or delivery outcome */ }
}

/** A retry only sends the exact payload and recipient captured for that run.
 * Unknown receipts are never eligible, so retries cannot duplicate an
 * accepted message whose acknowledgement was lost. */
export async function deliverTaskResult(taskId: string, runId: string, content?: string, isRetry = false): Promise<boolean> {
  const task = listTasks().find(item => item.id === taskId)
  const run = task?.runs?.find(item => item.runId === runId)
  if (!task || !run || run.outcome !== 'success' || (!isRetry && task.notifyOnComplete === false) ||
    !run.feishuDeliveryRequested || (isRetry ? run.delivery?.status !== 'failed' : !!run.delivery)) return false
  let payload: Payload | null = null
  let preparationError: string | undefined
  if (isRetry) {
    if (!['feishu-not-connected', 'no-chat'].includes(run.delivery?.error ?? '')) return false
    payload = readPayload(taskId, runId)
    if (!payload || payload.chatId !== run.feishuChatId) {
      if (beginTaskDelivery(taskId, runId, true)) finishTaskDelivery(taskId, runId, { status: 'failed', error: 'payload-unavailable' })
      return false
    }
  } else if (!validChat(run.feishuChatId)) preparationError = 'no-target'
  else if (typeof content !== 'string' || !content || content.length > 3000) preparationError = 'payload-unavailable'
  else {
    payload = { version: 1, taskId, runId, chatId: run.feishuChatId, content }
    try { pruneTaskDeliveryPayloads(); writePayload(payload) } catch { payload = null; preparationError = 'payload-unavailable' }
  }
  const claimed = beginTaskDelivery(taskId, runId, isRetry)
  if (!claimed) return false
  if (!payload) {
    finishTaskDelivery(taskId, runId, { status: 'failed', error: preparationError ?? 'payload-unavailable' })
    return false
  }
  try {
    const result = await feishuConnectionManager.pushTaskResult(payload.content, payload.chatId)
    finishTaskDelivery(taskId, runId, result.ok ? { status: 'sent' } : {
      status: result.uncertain ? 'unknown' : 'failed', error: result.error ?? 'send-failed'
    })
    if (result.ok) { try { unlinkSync(payloadFile(taskId, runId)) } catch { /* bounded cleanup retries later */ } }
    return result.ok
  } catch {
    finishTaskDelivery(taskId, runId, { status: 'unknown', error: 'send-failed' })
    return false
  }
}
