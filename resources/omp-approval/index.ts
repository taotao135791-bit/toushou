/**
 * omp-approval — per-tool approval extension for pi, bundled with OMP GUI.
 *
 * Loaded into every GUI-spawned session via `pi --mode rpc -e <this file>`.
 * Behavior is driven by a JSON config file whose path is passed in the
 * OMP_APPROVAL_CONFIG env var (written by the GUI on each session start):
 *
 *   { "mode": "off" | "writes" | "all", "locale": "zh" | "en" }
 *
 * - off:    every tool call is allowed (extension is inert)
 * - writes: bash/edit/write need approval, everything else passes
 * - all:    every tool call needs approval
 *
 * When approval is needed the extension opens a select dialog through
 * ctx.ui.select (the UI context passed as the handler's second argument),
 * which surfaces in the GUI as an extension_ui_request.
 * "Always allow" is remembered per tool name for the rest of the session.
 * The config file is re-read (mtime-cached) on every tool call, so the GUI
 * can change modes for running sessions by rewriting the file.
 *
 * Plain TypeScript, no dependencies beyond node:fs — pi loads this with jiti.
 */

import { readFileSync, statSync } from 'node:fs'

interface ApprovalConfig {
  mode?: 'off' | 'writes' | 'all'
  locale?: 'zh' | 'en'
}

interface ToolCallEventLike {
  toolName: string
  input: Record<string, unknown>
}

interface ExtensionContextLike {
  hasUI?: boolean
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>
  }
}

interface ExtensionApiLike {
  on(
    event: 'tool_call',
    handler: (
      event: ToolCallEventLike,
      ctx: ExtensionContextLike
    ) => Promise<{ block?: boolean; reason?: string }>
  ): void
}

const WRITE_TOOLS = new Set(['bash', 'edit', 'write'])

/** Tool names the user chose to always allow for this session. */
const alwaysAllowed = new Set<string>()

let cachedConfig: ApprovalConfig = { mode: 'off' }
let cachedMtimeMs = -1

function loadConfig(): ApprovalConfig {
  const file = process.env.OMP_APPROVAL_CONFIG
  if (!file) return { mode: 'off' }
  try {
    const mtimeMs = statSync(file).mtimeMs
    if (mtimeMs !== cachedMtimeMs) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ApprovalConfig
      cachedConfig = parsed && typeof parsed === 'object' ? parsed : { mode: 'off' }
      cachedMtimeMs = mtimeMs
    }
  } catch {
    // Missing/corrupt config: keep the last known-good one.
  }
  return cachedConfig
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash' && typeof input.command === 'string') {
    return truncate(`$ ${input.command}`, 160)
  }
  if ((toolName === 'edit' || toolName === 'write') && typeof input.path === 'string') {
    return truncate(input.path, 160)
  }
  let detail = ''
  try {
    detail = JSON.stringify(input) ?? ''
  } catch {
    detail = ''
  }
  return truncate(`${toolName} ${detail}`.trim(), 160)
}

export default function ompApproval(api: ExtensionApiLike): void {
  api.on('tool_call', async (event, ctx) => {
    const config = loadConfig()
    const mode = config.mode ?? 'off'
    if (mode === 'off') return {}
    if (mode === 'writes' && !WRITE_TOOLS.has(event.toolName)) return {}
    if (alwaysAllowed.has(event.toolName)) return {}
    // RPC sessions always have dialog-capable UI, but guard anyway: when no
    // UI is available we cannot ask, so fail closed.
    if (!ctx || ctx.hasUI === false || typeof ctx.ui?.select !== 'function') {
      return { block: true, reason: 'Approval required but no UI available' }
    }

    const zh = config.locale === 'zh'
    const summary = summarize(event.toolName, event.input ?? {})
    const title = zh ? `批准工具调用：${summary}` : `Approve tool call: ${summary}`
    const options = zh
      ? ['允许一次', `本会话始终允许 ${event.toolName}`, '拒绝']
      : ['Allow once', `Always allow ${event.toolName} for this session`, 'Deny']

    const choice = await ctx.ui.select(title, options)
    if (choice === options[0]) return {}
    if (choice === options[1]) {
      alwaysAllowed.add(event.toolName)
      return {}
    }
    // Deny, or undefined when the user dismissed the dialog.
    return { block: true, reason: `User declined ${event.toolName}` }
  })
}
