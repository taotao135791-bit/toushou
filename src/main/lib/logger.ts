import { app } from 'electron'
import { appendFile, mkdir, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

/**
 * Minimal main-process file logger.
 *
 * Packaged Electron apps discard stdout, so without this a user-reported
 * problem is undebuggable. Everything logged through console.* (the codebase's
 * existing habit) plus global crash handlers lands in
 * `userData/logs/main.log`, capped at ~1 MB with one rotated generation.
 *
 * Privacy: callers must never log secrets or full transcripts; this file is
 * for lifecycle, transport and error facts (see AGENTS.md).
 */

const MAX_LOG_BYTES = 1_000_000

let logFile: string | null = null
let writeChain: Promise<void> = Promise.resolve()
let currentBytes = 0
let sizeKnown = false

function timestamp(): string {
  return new Date().toISOString()
}

/**
 * Scrub credential material before anything touches disk. Upstream SDKs dump
 * full axios configs (including Authorization headers and user tokens) into
 * their error logs, and the diagnostics export ships the log tail, so every
 * line is redacted at write AND read time.
 */
export function redactSecrets(line: string): string {
  return line
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(
      /("(?:user_access_token|accessToken|access_token|app_secret|appSecret|token)"\s*:\s*")[^"]{4,}(")/gi,
      '$1***$2'
    )
    // Feishu token shapes: t-g10… (user), u-… (user), tenant tokens etc.
    .replace(/\b[tu]-[A-Za-z0-9]{10,}/g, '***')
}

function format(level: string, args: unknown[]): string {
  const parts = args.map((value) => {
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  })
  return redactSecrets(`[${timestamp()}] [${level}] ${parts.join(' ')}\n`)
}

function resolveLogFile(): string {
  if (!logFile) {
    logFile = path.join(app.getPath('userData'), 'logs', 'main.log')
  }
  return logFile
}

async function rotateIfNeeded(file: string): Promise<void> {
  if (!sizeKnown) {
    try {
      const existing = await readFile(file, 'utf-8').catch(() => '')
      currentBytes = Buffer.byteLength(existing, 'utf-8')
    } catch {
      currentBytes = 0
    }
    sizeKnown = true
  }
  if (currentBytes <= MAX_LOG_BYTES) return
  // One rotated generation; a leftover .old from a crashed run is replaced.
  await rename(file, `${file}.old`).catch(async () => {
    await unlink(`${file}.old`).catch(() => undefined)
    await rename(file, `${file}.old`).catch(() => undefined)
  })
  currentBytes = 0
}

function appendChunk(line: string): Promise<void> {
  const file = resolveLogFile()
  return mkdir(path.dirname(file), { recursive: true })
    .catch(() => undefined)
    .then(() => rotateIfNeeded(file))
    .then(() => appendFile(file, line, 'utf-8'))
    .then(() => {
      currentBytes += Buffer.byteLength(line, 'utf-8')
    })
    .catch(() => undefined)
}

function write(level: string, args: unknown[]): void {
  const line = format(level, args)
  writeChain = writeChain.then(() => appendChunk(line))
}

/** Tee console output into the file so existing call sites need no edits. */
export function installFileLogging(): void {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      write(level.toUpperCase(), args)
    }
  }
  process.on('uncaughtException', (error) => {
    console.error('[uncaught-exception]', error)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandled-rejection]', reason)
  })
}

/** Renderer exceptions forwarded through IPC (validated/trimmed at the boundary). */
export function logRendererError(message: string): void {
  console.error('[renderer]', message)
}

/** Last `bytes` of the log for the user-initiated diagnostics export. */
export async function readLogTail(bytes = 64 * 1024): Promise<string> {
  try {
    const file = resolveLogFile()
    const content = await readFile(file, 'utf-8')
    const tail = content.length > bytes ? content.slice(-bytes) : content
    // Older log lines were written unredacted — scrub again at read time.
    return redactSecrets(tail)
  } catch {
    return ''
  }
}
