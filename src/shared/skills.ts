import { Language, SkillEntry, SkillKind } from './types'

/**
 * SKILL 目录 (team skill library) — shared pure logic.
 *
 * The library is a flat folder of self-contained files a team shares with
 * each other: Markdown playbooks/prompt docs and single-file HTML tools.
 * Files are DATA, never code the host executes: Markdown is rendered with
 * the app's sandboxed renderer and HTML is served read-only over a loopback
 * URL for the hardened browser panel. A file's identity is its (sanitized)
 * basename, so no path component ever crosses the boundary as an id.
 */

export const SKILL_FILE_EXTENSIONS = ['md', 'html'] as const
export type SkillFileExtension = (typeof SKILL_FILE_EXTENSIONS)[number]

export const SKILL_LIMITS = {
  /** Import/read cap per file — keeps grants, IPC and previews bounded. */
  maxFileBytes: 2 * 1024 * 1024,
  /** Library listing cap; more files are ignored (and the folder is user-managed). */
  maxEntries: 500,
  /** Sanitized basename cap, including the extension. */
  maxFileNameLength: 120,
  /** Metadata string caps. */
  maxNameLength: 60,
  maxAuthorLength: 40,
  maxDescriptionLength: 160
} as const

// Unicode letters/digits first, then a conservative printable set (space,
// dot, underscore, hyphen, parentheses; CJK rides in via \p{L}). Path
// separators, control characters and a leading dot are all rejected.
const SAFE_FILE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._\-()]*$/u

export function skillKindForExtension(extension: string): SkillKind | null {
  if (extension === 'md') return 'markdown'
  if (extension === 'html') return 'html'
  return null
}

export function skillExtensionOf(fileName: string): SkillFileExtension | null {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return null
  const ext = fileName.slice(dot + 1).toLowerCase()
  return (SKILL_FILE_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as SkillFileExtension)
    : null
}

/**
 * A skill id IS a safe basename: no separators, no leading dot, bounded
 * length, ASCII-printable only. Anything else is rejected rather than
 * normalized so a bad caller can never smuggle traversal past the guard.
 */
export function isValidSkillId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  if (id.length === 0 || id.length > SKILL_LIMITS.maxFileNameLength) return false
  if (id.includes('/') || id.includes('\\') || id.startsWith('.')) return false
  if (!SAFE_FILE_NAME.test(id)) return false
  return skillExtensionOf(id) !== null
}

/**
 * Sanitize an incoming file's basename for storage in the library. Returns
 * null when nothing safe remains. The extension is always preserved.
 */
export function sanitizeSkillFileName(rawName: unknown): string | null {
  if (typeof rawName !== 'string') return null
  const base = rawName.split(/[\\/]/).pop() ?? ''
  const ext = skillExtensionOf(base)
  if (!ext) return null
  let stem = base.slice(0, base.length - ext.length - 1)
  // Keep CJK and ordinary text; strip filesystem-hostile characters (control
  // chars, Windows-forbidden punctuation) instead of whole words.
  stem = stem.replace(/[\u0000-\u001f<>:"|?*]+/g, '-').replace(/^\.+/, '').trim()
  stem = stem.replace(/\s+/g, ' ')
  if (!stem) stem = 'skill'
  const name = `${stem}.${ext}`
  if (name.length > SKILL_LIMITS.maxFileNameLength) {
    return `${stem.slice(0, SKILL_LIMITS.maxFileNameLength - ext.length - 1)}.${ext}`
  }
  return name
}

function clip(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + '…'
}

export interface SkillMetadata {
  name: string
  author: string
  description: string
}

/**
 * Extract display metadata from file content. An optional YAML-ish front
 * matter block (`---` … `---` with `key: value` lines) supplies
 * name/author/description; otherwise the name falls back to the file stem
 * and the description to the first meaningful line. Never throws.
 */
export function parseSkillMetadata(content: string, fileName: string): SkillMetadata {
  const fallbackName = clip(fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), SKILL_LIMITS.maxNameLength) || fileName
  const meta: SkillMetadata = { name: fallbackName, author: '', description: '' }

  const lines = content.split('\n')
  let start = 0
  if (lines[0]?.trim() === '---') {
    let end = -1
    for (let i = 1; i < lines.length && i <= 20; i++) {
      if (lines[i].trim() === '---') {
        end = i
        break
      }
    }
    if (end > 0) {
      for (let i = 1; i < end; i++) {
        const match = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(lines[i])
        if (!match) continue
        const value = match[2]
        const key = match[1]
        if (key === 'name') meta.name = clip(value, SKILL_LIMITS.maxNameLength) || meta.name
        if (key === 'author') meta.author = clip(value, SKILL_LIMITS.maxAuthorLength)
        if (key === 'description') {
          meta.description = clip(value, SKILL_LIMITS.maxDescriptionLength)
        }
      }
      start = end + 1
    }
  }

  if (!meta.description) {
    for (let i = start; i < lines.length && i < start + 60; i++) {
      const line = lines[i].trim()
      if (!line || line.startsWith('---') || line.startsWith('#')) continue
      const stripped = line.replace(/<[^>]+>/g, '')
      if (stripped.trim()) {
        meta.description = clip(stripped, SKILL_LIMITS.maxDescriptionLength)
        break
      }
    }
  }
  return meta
}

/** Drop a leading YAML-ish front-matter block so chat prompts stay on the SOP. */
export function stripSkillFrontMatter(content: string): string {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return content.replace(/^\uFEFF/, '')
  for (let i = 1; i < lines.length && i <= 20; i++) {
    if (lines[i].trim() === '---') {
      return lines.slice(i + 1).join('\n').replace(/^\n+/, '')
    }
  }
  return content.replace(/^\uFEFF/, '')
}

/** Escape a title for use inside a double-quoted XML attribute. */
function escapeSkillTitle(name: string): string {
  return name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

/**
 * Wrap a library Markdown document as the system-prompt block injected at
 * session launch. The <team-skill> delimiters keep playbook content from
 * being confused with host instructions, and the header tells the agent to
 * follow this SOP rather than invent a different process. HTML tools are
 * never sent this way (they open in the browser panel).
 */
export function formatSkillSystemPrompt(
  name: string,
  content: string,
  language: Language = 'zh'
): string {
  const body = stripSkillFrontMatter(content).trim()
  const title = name.trim() || 'SKILL'
  if (language === 'en') {
    return [
      'A team skill/playbook is loaded below inside <team-skill> tags. Follow it exactly for this session and do not invent a different process. If anything is missing, ask before acting.',
      `<team-skill name="${escapeSkillTitle(title)}">`,
      '# ' + title,
      '',
      body,
      '</team-skill>'
    ].join('\n')
  }
  return [
    '本会话在 <team-skill> 标签内加载了一份团队打法（SKILL）。请严格按它执行，不要另起一套流程；信息不够时先问用户再动手。',
    `<team-skill name="${escapeSkillTitle(title)}">`,
    '# ' + title,
    '',
    body,
    '</team-skill>'
  ].join('\n')
}

/**
 * The short composer line sent when a skill launches a chat. The full SOP
 * rides in the session system prompt (see formatSkillSystemPrompt), so the
 * visible message stays a clean reference instead of a pasted document.
 */
export function formatSkillChatReference(name: string, language: Language = 'zh'): string {
  const title = name.trim() || 'SKILL'
  if (language === 'en') {
    return `Loaded the team skill "${title}" as this session's SOP. Follow it exactly; ask me first if anything is missing.`
  }
  return `已加载团队 SKILL《${title}》作为本会话的执行 SOP。请严格按它执行；信息不够先问我再动手。`
}

/**
 * Full-content message for sending a skill into an EXISTING session, where
 * system-prompt injection is no longer possible (the process already runs).
 * The instruction header keeps the same follow-the-SOP contract as the
 * injected variant; the body rides as an ordinary chat message.
 */
export function formatSkillChatMessage(
  name: string,
  content: string,
  language: Language = 'zh'
): string {
  const body = stripSkillFrontMatter(content).trim()
  const title = name.trim() || 'SKILL'
  if (language === 'en') {
    return [
      'Follow this team skill/playbook exactly for the rest of this conversation. Do not invent a different process. If anything is missing, ask me before acting.',
      '',
      '# ' + title,
      '',
      body
    ].join('\n')
  }
  return [
    '接下来请严格按这份团队打法（SKILL）执行，不要另起一套流程。如果信息不够，先问我再动手。',
    '',
    '# ' + title,
    '',
    body,
  ].join('\n')
}

/** Build a list entry from already-validated primitives (Main-side reader). */
export function buildSkillEntry(
  fileName: string,
  kind: SkillKind,
  content: string,
  sizeBytes: number,
  updatedAtMillis: number
): SkillEntry {
  const meta = parseSkillMetadata(content, fileName)
  return {
    id: fileName,
    kind,
    name: meta.name,
    author: meta.author,
    description: meta.description,
    sizeBytes,
    updatedAtMillis
  }
}
