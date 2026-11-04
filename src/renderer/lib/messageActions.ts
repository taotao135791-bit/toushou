import { splitConnectionMarkers } from './connectionMarkers'

/** Export what the message displays, without the assistant's UI-only markers. */
export function messageActionText(message: { role: string; content: string }): string {
  // A marker typed by the user is literal input, not an assistant UI instruction.
  return message.role === 'user' ? message.content : splitConnectionMarkers(message.content).clean
}

/** A rejected clipboard write must never produce a success acknowledgement. */
export async function copyMessageText(text: string, writeText: (text: string) => Promise<void>): Promise<boolean> {
  try {
    await writeText(text)
    return true
  } catch {
    return false
  }
}
