import { BrowserWindow, Notification } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import { SessionEvent } from '../shared/types'
import { getLastAssistantText, getSession } from './omp'
import { getStore } from './store'

/**
 * Desktop notification when an agent turn finishes (agent_end → status idle)
 * while the window is unfocused. Clicking it focuses the window and asks the
 * renderer to select that session.
 */
export function maybeNotifyTurnFinished(event: SessionEvent): void {
  if (event.type !== 'status' || event.status !== 'idle') return
  if (getStore('notifications') === false) return

  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed() && win.isFocused()) return

  const title = getSession(event.sessionId)?.title || 'AdPilot'
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

  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed() && win.isFocused()) return

  const zh = getStore('language') !== 'en'
  const title = getSession(event.sessionId)?.title || 'AdPilot'
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
