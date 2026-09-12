import { BrowserWindow, Notification } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import { SessionEvent } from '../shared/types'
import { getLastAssistantText, getSession } from './omp'
import { getStore } from './store'
import { listAllSessions } from './sessionHistory'

/**
 * Desktop notification when an agent turn finishes (agent_end → status idle)
 * while the window is unfocused. Clicking it focuses the window and asks the
 * renderer to select that session.
 */
export function maybeNotifyTurnFinished(event: SessionEvent): void {
  if (event.type !== 'status' || event.status !== 'idle') return
  if (getStore('notifications') === false) return
  if (!Notification.isSupported()) return
  // Remote-channel turns (Feishu) already deliver their answer in the chat
  // they came from; a desktop popup per message is spam and can leak content
  // into the notification center. Task sessions get their own dedicated
  // notice via notifyTaskFinished instead of this generic one.
  const origin = getSession(event.sessionId)?.origin
  if (origin === 'feishu' || origin === 'task') return

  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed() && win.isFocused()) return

  const title = getSession(event.sessionId)?.title || '投手'
  // Privacy: by default the notification body is generic ("Agent turn finished.")
  // and never leaks assistant response content — previews are opt-in. Previews
  // may surface in the OS notification center / lock screen.
  const text = getLastAssistantText(event.sessionId).trim()
  const body =
    getStore('notificationPreviews') === true && text
      ? text.slice(0, 120)
      : 'Agent turn finished.'

  const notification = new Notification({ title, body, silent: false })
  notification.on('click', () => {
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
      win.webContents.send(IPC_CHANNELS.NOTIFY_SELECT_SESSION, event.sessionId)
    }
  })
  notification.show()
}

/**
 * Desktop notification when an extension dialog (typically the approval
 * prompt) is waiting for input while the window is unfocused — otherwise an
 * ask-mode session would stall silently in the background.
 */
export function maybeNotifyUiRequest(event: SessionEvent): void {
  if (event.type !== 'ui_request') return
  if (getStore('notifications') === false) return
  if (!Notification.isSupported()) return

  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed() && win.isFocused()) return

  const zh = getStore('language') !== 'en'
  const title = getSession(event.sessionId)?.title || '投手'
  const detail = (event.title || '').slice(0, 100)
  const body = zh
    ? `等待你的操作：${detail || '插件请求'}`
    : `Waiting for input: ${detail || 'plugin request'}`

  const notification = new Notification({ title, body, silent: false })
  notification.on('click', () => {
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
      win.webContents.send(IPC_CHANNELS.NOTIFY_SELECT_SESSION, event.sessionId)
    }
  })
  notification.show()
}


/**
 * Where a task-notification click should land: the live run session when it
 * still exists, else the newest durable row titled after the task (task
 * sessions are named after their task), else nowhere (just focus).
 */
export async function resolveTaskNotificationTarget(
  taskName: string,
  sessionId?: string
): Promise<{ kind: 'select'; sessionId: string } | { kind: 'history'; uuid: string; cwd: string } | null> {
  if (sessionId && getSession(sessionId)) return { kind: 'select', sessionId }
  const rows = await listAllSessions()
  const row = rows.find((entry) => entry.title === taskName) // newest first
  if (row) return { kind: 'history', uuid: row.uuid, cwd: row.cwd }
  return null
}

/**
 * Task-scoped completion notice. Fires regardless of window focus (the whole
 * point of a scheduled task is that nobody is watching) but still honors the
 * global notifications setting. Clicking jumps to the run's session — the
 * same affordance the per-turn notice already has — and falls back to the
 * task's newest durable transcript after a restart.
 */
export function notifyTaskFinished(taskName: string, sessionId?: string): void {
  if (getStore('notifications') === false) return
  if (!Notification.isSupported()) return
  const zh = getStore('language') !== 'en'
  const win = BrowserWindow.getAllWindows()[0]
  const notification = new Notification({
    title: zh ? '定时任务完成' : 'Task finished',
    body: zh ? `任务「${taskName}」本轮已执行完成。` : `Task "${taskName}" finished its run.`
  })
  notification.on('click', () => {
    if (!win || win.isDestroyed()) return
    win.show()
    win.focus()
    void resolveTaskNotificationTarget(taskName, sessionId).then((target) => {
      if (!target || !win || win.isDestroyed()) return
      if (target.kind === 'select') {
        win.webContents.send(IPC_CHANNELS.NOTIFY_SELECT_SESSION, target.sessionId)
      } else {
        win.webContents.send(IPC_CHANNELS.NOTIFY_OPEN_HISTORY, { uuid: target.uuid, cwd: target.cwd })
      }
    })
  })
  notification.show()
}

/** A task disabled itself after repeated failures — the user must know. */
export function notifyTaskAutoDisabled(taskName: string): void {
  if (!Notification.isSupported()) return
  const zh = getStore('language') !== 'en'
  const win = BrowserWindow.getAllWindows()[0]
  const notification = new Notification({
    title: zh ? '定时任务已自动暂停' : 'Task auto-paused',
    body: zh
      ? `任务「${taskName}」连续 3 次启动失败，已自动停用。请检查项目目录和运行时后重新启用。`
      : `Task "${taskName}" failed to start 3 times in a row and was disabled. Check its project folder and runtime, then re-enable.`
  })
  notification.on('click', () => {
    if (!win || win.isDestroyed()) return
    win.show()
    win.focus()
  })
  notification.show()
}
