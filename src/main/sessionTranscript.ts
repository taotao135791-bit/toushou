import { constants, createReadStream } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { isPromptImageMime, MAX_IMAGE_BYTES, MAX_IMAGE_COUNT, MAX_TOTAL_IMAGE_BYTES } from '../shared/promptImages'
import { defaultPiAgentDir } from './piSettings'
import { isSessionFilePath } from './sessionHistory'
import { createInterface } from 'node:readline'
import { ChatMessage } from '../shared/types'
import { getSession, getSessionMessages } from './omp'
import { mapAgentMessages, type AgentMessage } from './messageMapping'

/** Bounded, control-char-free session id (mirrors the IPC id guard in ipc.ts). */
function isSafeSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(value)
  )
}

/** Read the live transcript, falling back to its authorized journal when the runtime has no messages. */
export async function readSessionTranscript(sessionId: unknown): Promise<ChatMessage[] | null> {
  if (!isSafeSessionId(sessionId)) return null
  const session = getSession(sessionId)
  if (!session) return null
  const live = await getSessionMessages(sessionId)
  if (live?.length) return live

  // A resumed session can report its future journal before writing it.
  // Try the current journal first, then the journal it resumed from.
  for (const journal of new Set([session.sessionFile, session.resumeFrom])) {
    if (!journal || !isSessionFilePath(journal)) continue
    const stored = await readSessionFileTranscript(journal)
    if (stored?.length) return stored
  }
  return live
}

/** Safety bounds for the file peek: a runaway file must never wedge Main. */
const PEEK_MAX_BYTES = 64 * 1024 * 1024
const PEEK_MAX_MESSAGES = 20_000

/** OMP stores user image bytes in its content-addressed, profile-wide blobs directory. */
async function readImageBlob(dir: string, hash: string, limit: number): Promise<Buffer | null> {
  const target = path.join(dir, hash)
  try {
    // Both the store and the file must be under the trusted profile. Refuse
    // redirected directories, symlink files and non-regular files.
    if (path.relative(target, await realpath(target)) !== '') return null
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size <= 0 || stat.size > limit) return null
      const data = Buffer.allocUnsafe(stat.size)
      let offset = 0
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
        if (!bytesRead) return null
        offset += bytesRead
      }
      return createHash('sha256').update(data).digest('hex') === hash ? data : null
    } finally { await handle.close() }
  } catch { return null }
}

function matchesImageMime(data: Buffer, mime: string): boolean {
  switch (mime) {
    case 'image/png': return data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    case 'image/jpeg': return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))
    case 'image/webp': return data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
    default: return false
  }
}

async function hydrateUserImages(messages: AgentMessage[], file: string, agentDir?: string): Promise<void> {
  let store: string | undefined
  let bytesLeft = PEEK_MAX_BYTES
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    let images = 0
    let turnBytes = 0
    for (const block of message.content) {
      if (block?.type !== 'image' || ++images > MAX_IMAGE_COUNT) continue
      const image = block as { data?: unknown; mimeType?: unknown }
      if (typeof image.data !== 'string' || typeof image.mimeType !== 'string' || !isPromptImageMime(image.mimeType)) continue
      const hash = /^blob:sha256:([a-f0-9]{64})$/.exec(image.data)?.[1]
      if (!hash) continue
      if (!store) {
        const profile = agentDir ?? defaultPiAgentDir()
        if (!isSessionFilePath(file, profile)) return
        try { store = path.join(await realpath(profile), 'blobs') } catch { return }
      }
      const limit = Math.min(MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES - turnBytes, Math.floor(bytesLeft / 4) * 3)
      if (limit <= 0) break
      const data = await readImageBlob(store, hash, limit)
      if (!data || !matchesImageMime(data, image.mimeType)) continue
      image.data = data.toString('base64')
      bytesLeft -= Math.ceil(data.length / 3) * 4
      turnBytes += data.length
    }
  }
}

/**
 * Instant view of a DURABLE session file, without spawning the runtime
 * (dsh's model: reading a conversation is a data read; attaching the runtime
 * happens when the user actually interacts). Message entries pass through
 * mapAgentMessages — the same mapper the live resume path uses — so a later
 * live swap-in replaces like-for-like. Returns null when the file cannot be
 * read or holds no messages.
 */
export async function readSessionFileTranscript(filePath: string, options: { agentDir?: string; hydrateImages?: boolean } = {}): Promise<ChatMessage[] | null> {
  const agentMessages: AgentMessage[] = []
  try {
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let bytes = 0
    for await (const line of lines) {
      bytes += Buffer.byteLength(line) + 1
      if (bytes > PEEK_MAX_BYTES) break
      if (!line) continue
      try {
        const entry: unknown = JSON.parse(line)
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as { type?: unknown }).type === 'message') {
          const message = (entry as { message?: unknown }).message
          if (message && typeof message === 'object') agentMessages.push(message as AgentMessage)
          if (agentMessages.length >= PEEK_MAX_MESSAGES) break
        }
      } catch {
        // Partial trailing line or a non-JSON record — skip; the runtime's own
        // parser is equally tolerant of its own journal format.
      }
    }
  } catch {
    return null
  }
  if (agentMessages.length === 0) return null
  if (options.hydrateImages !== false) await hydrateUserImages(agentMessages, filePath, options.agentDir)
  return mapAgentMessages(agentMessages)
}
