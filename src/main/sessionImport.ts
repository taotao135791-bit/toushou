import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { SessionImportResult, SessionImportSource } from '../shared/sessionImport'
import { canonicalExistingPath } from './canonicalPath'
import { ompSessionDirCandidatesFor, sessionsRoot } from './sessionHistory'

const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i
const MAX_FILE_BYTES = 64 * 1024 * 1024

type Json = Record<string, unknown>
type Role = 'user' | 'assistant'
type Message = { role: Role; text: string; timestamp: number }
type Transcript = { id: string; cwd?: string; title?: string; startedAt?: number; messages: Message[] }

type ImportOptions = {
  source: SessionImportSource
  sourceDirectory: string
  agentDir: string
  defaultWorkspace: string | undefined
  projects: Set<string>
  isWorkspaceBusy?: (workspace: string) => boolean
}

function asObject(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function timestamp(value: unknown): number | undefined {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) && time >= 0 && time < 8.64e15 ? time : undefined
}

function textContent(value: unknown, types: readonly string[]): string | undefined {
  if (typeof value === 'string') return asString(value)
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap(item => {
    const block = asObject(item)
    return typeof block?.type === 'string' && types.includes(block.type) && typeof block.text === 'string' ? [block.text] : []
  })
  return asString(parts.join('\n'))
}

function parseLine(line: string): Json | undefined {
  if (!line.trim()) return undefined
  try { return asObject(JSON.parse(line)) } catch { return undefined }
}

function sessionId(value: unknown): string | undefined {
  const string = asString(value)
  const matched = string?.match(UUID)?.[0]
  return string === matched ? matched?.toLowerCase() : undefined
}

function fileId(source: SessionImportSource, name: string): string | undefined {
  if (source === 'claude') return sessionId(name.slice(0, -'.jsonl'.length))
  if (!name.startsWith('rollout-')) return undefined
  return sessionId(name.match(UUID)?.[0])
}

// Older Codex journals may only have response items. User-role context
// injected by the runtime is recorded in the same place as typed prompts.
function codexVisibleUserText(content: unknown): string | undefined {
  const isUserText = (value: unknown) => {
    if (typeof value !== 'string') return false
    const text = value.trimStart()
    return !/^<(?:environment_context|user_instructions|developer_instructions|system-reminder|skills_instructions|collaboration_mode|permissions instructions)\b/i.test(text) &&
      !/^# AGENTS\.md instructions for\b/i.test(text)
  }
  if (typeof content === 'string') return isUserText(content) ? asString(content) : undefined
  if (!Array.isArray(content)) return undefined
  return textContent(content.filter(item => isUserText(asObject(item)?.text)), ['input_text', 'text'])
}

function parseCodex(lines: string[], id: string, fallbackTime: number): Transcript | undefined {
  const transcript: Transcript = { id, messages: [] }
  let sawHeader = false
  let lastKind: string | undefined
  const completedItems = new Set<string>()
  const add = (role: Role, value: string | undefined, time: number, kind: string) => {
    if (!value) return
    const previous = transcript.messages.at(-1)
    // Codex may serialize the same utterance as both an event and a response item.
    if (role === previous?.role && value === previous.text && lastKind !== kind && Math.abs(time - previous.timestamp) < 5000) return
    transcript.messages.push({ role, text: value, timestamp: time })
    lastKind = kind
  }
  for (const line of lines) {
    const entry = parseLine(line)
    const payload = asObject(entry?.payload)
    if (!payload) continue
    const time = timestamp(entry?.timestamp) ?? fallbackTime
    if (entry?.type === 'session_meta') {
      sawHeader = true
      // Multi-agent branches have their own rollout files; import top-level chats.
      if (payload.source === 'subagent' || asObject(payload.source)?.subagent) return undefined
      transcript.id = sessionId(payload.id) ?? id
      transcript.cwd = asString(payload.cwd)
      transcript.startedAt = timestamp(payload.timestamp) ?? time
      transcript.title = asString(payload.name) ?? asString(payload.title)
    } else if (entry?.type === 'event_msg') {
      if (payload.type === 'user_message') add('user', asString(payload.message), time, 'event')
      if (payload.type === 'agent_message') add('assistant', asString(payload.message), time, 'event')
      if (payload.type === 'item_completed') {
        const item = asObject(payload.item)
        const itemId = asString(item?.id)
        if (itemId && !completedItems.has(itemId)) {
          completedItems.add(itemId)
          if (item?.type === 'UserMessage') add('user', textContent(item.content, ['text']), time, 'item')
          if (item?.type === 'AgentMessage') add('assistant', textContent(item.content, ['Text', 'text']), time, 'item')
        }
      }
      if (payload.type === 'thread_name_updated') transcript.title = asString(payload.thread_name) ?? transcript.title
      if (payload.type === 'thread_rolled_back' && typeof payload.num_turns === 'number') {
        let remaining = payload.num_turns
        while (remaining > 0 && transcript.messages.length > 0) {
          if (transcript.messages.pop()?.role === 'user') remaining--
        }
        lastKind = undefined
      }
    } else if (entry?.type === 'response_item' && payload.type === 'message') {
      if (payload.role === 'assistant') add('assistant', textContent(payload.content, ['output_text', 'text']), time, 'response')
      if (payload.role === 'user') add('user', codexVisibleUserText(payload.content), time, 'response')
    }
  }
  if (!sawHeader) throw new Error('missing-codex-session-header')
  return transcript
}

function parseClaude(lines: string[], id: string, fallbackTime: number): Transcript | undefined {
  const transcript: Transcript = { id, messages: [] }
  const records: Json[] = []
  const byId = new Map<string, Json>()
  let leaf: Json | undefined
  let hasParents = false
  let aiTitle: string | undefined
  for (const line of lines) {
    const entry = parseLine(line)
    if (!entry) continue
    if (entry.type === 'continued-in' && sessionId(entry.continuedInSessionId)) return undefined
    if (entry.type === 'custom-title') transcript.title = asString(entry.customTitle) ?? transcript.title
    if (entry.type === 'ai-title') aiTitle = asString(entry.aiTitle) ?? aiTitle
    if (entry.isSidechain === true) continue
    const uuid = asString(entry.uuid)
    if (uuid) byId.set(uuid, entry)
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    if (sessionId(entry.sessionId) && sessionId(entry.sessionId) !== id) continue
    records.push(entry)
    if (!leaf || entry.isMeta !== true) leaf = entry
    hasParents ||= typeof entry.parentUuid === 'string'
  }
  if (records.length === 0 && !aiTitle && !transcript.title) throw new Error('missing-claude-session-messages')

  const active: Json[] = []
  if (hasParents && leaf) {
    const seen = new Set<Json>()
    for (let cursor: Json | undefined = leaf; cursor && !seen.has(cursor);) {
      active.push(cursor)
      seen.add(cursor)
      const parent = asString(cursor.parentUuid)
      cursor = parent ? byId.get(parent) : undefined
    }
    active.reverse()
  }
  let lastAssistantId: string | undefined
  for (const entry of hasParents ? active : records) {
    if (entry.isMeta === true || entry.isCompactSummary === true || (entry.type !== 'user' && entry.type !== 'assistant')) continue
    const role = entry.type
    transcript.cwd ??= asString(entry.cwd)
    const message = asObject(entry.message)
    const time = timestamp(entry.timestamp) ?? fallbackTime
    const text = textContent(message?.content, ['text'])
    if (!text) continue
    transcript.startedAt ??= time
    const assistantId = role === 'assistant' ? asString(message?.id) : undefined
    const previous = transcript.messages.at(-1)
    if (assistantId && lastAssistantId === assistantId && previous?.role === 'assistant') {
      previous.text += '\n' + text
      previous.timestamp = time
    } else {
      transcript.messages.push({ role, text, timestamp: time })
    }
    lastAssistantId = assistantId
  }
  transcript.title ??= aiTitle
  return transcript
}

function under(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

async function resolveStoragePath(directory: string): Promise<string> {
  try {
    return await realpath(directory)
  } catch (error) {
    const parent = path.dirname(directory)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === directory) throw error
    return path.join(await resolveStoragePath(parent), path.basename(directory))
  }
}

async function entries(directory: string, root: string, optional: boolean) {
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || !under(root, await realpath(directory))) {
      if (optional) return []
      throw new Error('invalid-session-directory')
    }
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function sourceFiles(source: SessionImportSource, root: string): Promise<string[]> {
  const files: string[] = []
  const scan = async (directory: string, depth: number, optional: boolean) => {
    for (const entry of await entries(directory, root, optional)) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name) &&
          fileId(source, entry.name.replace(/\.zst$/, ''))) files.push(fullPath)
      if (depth > 0 && entry.isDirectory() && (source === 'claude' || /^\d{2,4}$/.test(entry.name))) {
        await scan(fullPath, depth - 1, false)
      }
    }
  }
  if (source === 'codex') {
    await scan(root, 3, false)
    await scan(path.join(root, 'sessions'), 3, true)
    await scan(path.join(root, 'archived_sessions'), 0, true)
  } else {
    if (await lstat(path.join(root, 'projects')).then(info => info.isDirectory(), () => false)) {
      await scan(path.join(root, 'projects'), 1, false)
    } else {
      await scan(root, 1, false)
    }
  }
  // Reverted copies retain the same thread id. Prefer current session files,
  // the latest generation within that group, and JSONL over its compressed twin.
  return files.sort((a, b) => {
    const archived = (file: string) => Number(path.relative(root, file).split(path.sep)[0] === 'archived_sessions')
    return archived(a) - archived(b) || Number(a.endsWith('.zst')) - Number(b.endsWith('.zst')) || b.localeCompare(a)
  })
}

async function readTranscript(source: SessionImportSource, root: string, file: string): Promise<Transcript | undefined> {
  const id = fileId(source, path.basename(file))
  const resolved = await realpath(file)
  if (!id || !under(root, resolved)) throw new Error('invalid-transcript')
  const before = await lstat(file)
  if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error('invalid-transcript-size')
  const handle = await open(file, 'r')
  try {
    const after = await handle.stat()
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || await realpath(file) !== resolved) {
      throw new Error('transcript-changed')
    }
    // Bound the read to the inspected size even if the source agent is still appending.
    const buffer = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) throw new Error('transcript-truncated')
      offset += bytesRead
    }
    const lines = buffer.toString('utf8').split('\n')
    return source === 'codex' ? parseCodex(lines, id, before.mtimeMs) : parseClaude(lines, id, before.mtimeMs)
  } finally {
    await handle.close()
  }
}

function importedId(source: SessionImportSource, foreignId: string): string {
  const hash = createHash('sha256').update('toushou-session-import:' + source + ':' + foreignId).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

async function existingImports(sessions: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const directory of await entries(sessions, sessions, false)) {
    if (!directory.isDirectory()) continue
    for (const file of await entries(path.join(sessions, directory.name), sessions, false)) {
      const id = file.isFile() && file.name.endsWith('.jsonl') ? sessionId(file.name.slice(-42, -6)) : undefined
      if (id) ids.add(id)
    }
  }
  return ids
}

async function writeTranscript(root: string, directory: string, source: SessionImportSource, transcript: Transcript, id: string, workspace: string): Promise<boolean> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const realDirectory = await realpath(directory)
  if (!(await lstat(directory)).isDirectory() || path.dirname(realDirectory) !== root) throw new Error('invalid-session-directory')
  const startTime = transcript.startedAt ?? transcript.messages[0].timestamp
  const date = new Date(startTime).toISOString()
  const target = path.join(directory, `${date.replace(/[:.]/g, '-')}_${id}.jsonl`)
  const temporary = path.join(directory, `.${randomUUID()}.importing`)
  const title = (transcript.title ?? transcript.messages.find(message => message.role === 'user')?.text)
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  const records: Json[] = [
    { type: 'session', version: 3, id, timestamp: date, cwd: workspace, importedFrom: source, ...(title ? { title, titleSource: 'user' } : {}) }
  ]
  let parentId: string | null = null
  for (const [index, message] of transcript.messages.entries()) {
    const entryId = index.toString(16).padStart(8, '0')
    const content = [{ type: 'text', text: message.text }]
    const agentMessage = { role: message.role, content, timestamp: message.timestamp }
    records.push({
      type: 'message', id: entryId, parentId, timestamp: new Date(message.timestamp).toISOString(),
      message: message.role === 'user' ? agentMessage : {
        ...agentMessage,
        ...(source === 'codex' ? { api: 'openai-responses', provider: 'openai' } : { api: 'anthropic-messages', provider: 'anthropic' }),
        model: 'imported-history',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop'
      }
    })
    parentId = entryId
  }
  try {
    await writeFile(temporary, records.map(record => JSON.stringify(record)).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
    // Publish the complete transcript in one operation without overwriting an
    // existing session if a second process imported the same history.
    await link(temporary, target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

export function defaultImportSourceDirectory(source: SessionImportSource): string {
  const override = source === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR
  if (override && path.isAbsolute(override) && !override.includes('\0')) return override
  return path.join(homedir(), source === 'codex' ? '.codex' : '.claude')
}

export async function importSessionHistory(options: ImportOptions): Promise<SessionImportResult> {
  let root: string
  let files: string[]
  try {
    root = await realpath(options.sourceDirectory)
    files = await sourceFiles(options.source, root)
  } catch {
    return { ok: false, error: 'source-unavailable' }
  }
  const result = { ok: true as const, imported: 0, duplicates: 0, skipped: 0, failed: 0, defaultWorkspace: 0, compressed: 0 }
  if (files.length === 0) return result
  let sessions: string
  let known: Set<string>
  try {
    const directory = await resolveStoragePath(path.resolve(sessionsRoot(options.agentDir)))
    if (under(root, directory) || under(directory, root)) return { ok: false, error: 'destination-unavailable' }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    sessions = await realpath(directory)
    known = await existingImports(sessions)
  } catch {
    return { ok: false, error: 'destination-unavailable' }
  }
  for (const file of files) {
    try {
      const foreignId = fileId(options.source, path.basename(file).replace(/\.zst$/, ''))
      if (!foreignId) continue
      if (known.has(importedId(options.source, foreignId))) {
        result.duplicates++
        continue
      }
      if (file.endsWith('.zst')) {
        result.failed++
        result.compressed++
        continue
      }
      const transcript = await readTranscript(options.source, root, file)
      if (!transcript || !transcript.messages.some(message => message.role === 'user')) {
        result.skipped++
        continue
      }
      const id = importedId(options.source, transcript.id)
      if (known.has(id)) {
        result.duplicates++
        continue
      }
      let workspace: string | undefined
      if (transcript.cwd && path.isAbsolute(transcript.cwd) && !transcript.cwd.includes('\0')) {
        // Only the user's already registered project gets authority. Never
        // add a project or grant filesystem access based on foreign metadata.
        // Avoid dereferencing arbitrary paths declared in a foreign transcript.
        const normalized = path.resolve(transcript.cwd)
        if (options.projects.has(normalized)) workspace = normalized
        if (!workspace && process.platform === 'darwin' && normalized.startsWith('/tmp/')) {
          const privateAlias = '/private' + normalized
          if (options.projects.has(privateAlias)) workspace = privateAlias
        }
      }
      const unassigned = !workspace
      workspace ??= options.defaultWorkspace
      if (!workspace || options.isWorkspaceBusy?.(workspace) || canonicalExistingPath(workspace) !== workspace) {
        result.failed++
        continue
      }
      const [destination] = ompSessionDirCandidatesFor(workspace, options.agentDir, canonicalExistingPath)
      if (await writeTranscript(sessions, destination, options.source, transcript, id, workspace)) {
        result.imported++
        if (unassigned) result.defaultWorkspace++
      } else {
        result.duplicates++
      }
      known.add(id)
    } catch {
      result.failed++
    }
  }
  return result
}
