import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Per-project knowledge file (投手.md).
 *
 * Lives in the project root alongside the code. Read at session-spawn time
 * and injected as a system-prompt prefix so the agent knows the account
 * structure, fixed metric definitions, client context, and historical
 * decisions without the user repeating them every session.
 *
 * Plain markdown, user-editable in any editor. No lock-in, no database.
 */

export const KNOWLEDGE_FILENAME = '投手.md'

/** Read the knowledge file content; null when absent or unreadable. */
export function readKnowledge(projectDir: string): string | null {
  const filePath = path.join(projectDir, KNOWLEDGE_FILENAME)
  if (!existsSync(filePath)) return null
  try {
    const content = readFileSync(filePath, 'utf-8')
    return content.trim() || null
  } catch {
    return null
  }
}

/** Write the knowledge file. Creates or overwrites. */
export function writeKnowledge(projectDir: string, content: string): boolean {
  try {
    writeFileSync(path.join(projectDir, KNOWLEDGE_FILENAME), content, 'utf-8')
    return true
  } catch {
    return false
  }
}

/** True when the knowledge file exists. */
export function hasKnowledge(projectDir: string): boolean {
  return existsSync(path.join(projectDir, KNOWLEDGE_FILENAME))
}
