import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, app } from 'electron'
import { IPC_CHANNELS } from '../../../shared/constants'
import { ConnectionDefinition, ConnectionStatus, FigmaConnectionSnapshot } from '../../../shared/connections'
import { McpStorePaths, defaultMcpStorePaths, removeMcpConnection, upsertManagedServer } from '../mcp/McpConnectionStore'

/**
 * Figma Dev Mode MCP connector — the local, code-token-only flavor.
 *
 * Figma's desktop app exposes an official LOCAL MCP server at
 * http://127.0.0.1:3845/mcp (Preferences → Enable Dev Mode MCP Server). Its
 * `use_figma` tool executes Plugin-API JavaScript inside the file on the
 * user's machine: no server-side generation, no Figma-side AI credits — all
 * reasoning happens in the connected coding model. That is deliberately the
 * ONLY flavor this connector registers; the remote mcp.figma.com flavor can
 * consume Figma-side generation and is not wired in.
 *
 * No credentials exist on this path at all: the endpoint is loopback and
 * unauthenticated, so this manager persists nothing secret — it only writes
 * the runtime mcp.json entry and installs the bundled agent skills (whose
 * reference trees live on disk for the agent's file tools to grep).
 */

const MCP_SERVER_NAME = 'figma'
const FIGMA_MCP_ENDPOINT = 'http://127.0.0.1:3845/mcp'
/** The four bundled skill folders (resources/figma-skills/<name>). */
const SKILL_TREE_NAMES = ['figma-use', 'figma-use-figjam', 'figma-use-motion', 'figma-use-slides'] as const

const FIGMA_DEFINITION: ConnectionDefinition = {
  id: 'figma',
  kind: 'channel',
  label: 'Figma（Dev Mode MCP · 只花代码 token）',
  description: '接入 Figma 桌面端的本地 Dev Mode MCP：use_figma 在本机执行 Plugin API，智能全部来自你的模型，不消耗 Figma AI 额度。',
  capabilities: ['mcp']
}

export interface FigmaProbeResult {
  ok: boolean
  toolCount?: number
  detail: string
}

/** Extract JSON-RPC payloads from a direct JSON or SSE (data: …) response body. */
function parseRpcResponses(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    try {
      const parsed = JSON.parse(trimmed.slice(5).trim())
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
    } catch {
      /* 非 JSON 的 data 行 */
    }
  }
  if (out.length === 0) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
    } catch {
      /* 非 JSON */
    }
  }
  return out
}

export class FigmaConnectionManager {
  private readonly mcpPaths: McpStorePaths
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  private readonly now: () => number
  private state: 'idle' | 'connecting' | 'connected' | 'degraded' | 'failed' = 'idle'
  private lastError: string | undefined
  private lastConnectedAt: number | undefined
  private toolCount: number | undefined

  constructor(options: {
    mcpPaths?: McpStorePaths
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
    now?: () => number
  } = {}) {
    this.mcpPaths = options.mcpPaths ?? defaultMcpStorePaths()
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? Date.now
  }

  /** App-start hook: restore from the managed mcp entry, then probe quietly. */
  async initialize(): Promise<void> {
    const servers = this.readMcpServers()
    if (!(MCP_SERVER_NAME in servers)) return
    this.state = 'connected'
    this.emitState()
    void this.probe().then((result) => {
      if (this.state !== 'connected') return
      if (result.ok) {
        this.toolCount = result.toolCount
        this.lastConnectedAt = this.now()
      } else {
        // The Figma desktop app is simply not running right now; the entry
        // stays installed and will work the next time Figma is open.
        this.state = 'degraded'
        this.lastError = result.detail
      }
      this.emitState()
    })
  }

  getSnapshot(): FigmaConnectionSnapshot {
    return {
      definition: FIGMA_DEFINITION,
      status: this.snapshotStatus(),
      connected: this.state === 'connected',
      ...(this.toolCount !== undefined ? { toolCount: this.toolCount } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {})
    }
  }

  /** Live probe of the local endpoint: is the Figma desktop app serving? */
  async probe(timeoutMs = 3_000): Promise<FigmaProbeResult> {
    try {
      const init = await this.rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'toushou-figma-probe', version: '1.0' }
      }, timeoutMs)
      if (!init.ok) {
        return { ok: false, detail: `Figma 桌面端未响应（HTTP ${init.status}）——请打开 Figma 桌面端并在 偏好设置 中启用 Dev Mode MCP Server` }
      }
      const text = await init.text()
      if (!text.includes('"jsonrpc"')) {
        return { ok: false, detail: '端点不是 MCP 协议——请确认 Figma 桌面端已启用 Dev Mode MCP Server' }
      }
      let toolCount: number | undefined
      try {
        const tools = await this.rpc('tools/list', {}, timeoutMs)
        if (tools.ok) {
          const payloads = parseRpcResponses(await tools.text())
          const result = payloads.find((p) => p.result && typeof p.result === 'object')?.result as
            | { tools?: unknown[] }
            | undefined
          if (result && Array.isArray(result.tools)) toolCount = result.tools.length
        }
      } catch {
        /* tools/list 失败不影响连接判定 */
      }
      return { ok: true, toolCount, detail: toolCount !== undefined ? `已连接，发现 ${toolCount} 个工具` : '已连接' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, detail: `无法连接本地端点（${message.slice(0, 120)}）——请打开 Figma 桌面端并在 偏好设置 中启用 Dev Mode MCP Server` }
    }
  }

  /** Verify the endpoint, register the mcp entry, install the skills. */
  async connect(): Promise<FigmaConnectionSnapshot> {
    this.state = 'connecting'
    this.lastError = undefined
    this.emitState()
    const probe = await this.probe()
    if (!probe.ok) {
      this.state = 'failed'
      this.lastError = probe.detail
      this.emitState()
      return this.getSnapshot()
    }
    const upsert = upsertManagedServer(
      MCP_SERVER_NAME,
      { type: 'http', url: FIGMA_MCP_ENDPOINT, timeout: 60_000 },
      this.mcpPaths
    )
    if (!upsert.ok) {
      this.state = 'failed'
      this.lastError = `写入 mcp.json 失败：${upsert.error}`
      this.emitState()
      return this.getSnapshot()
    }
    const skills = this.installSkills()
    if (!skills.ok) {
      this.state = 'degraded'
      this.lastError = `技能安装失败：${skills.error}（连接本身已可用）`
    } else {
      this.state = 'connected'
    }
    this.toolCount = probe.toolCount
    this.lastConnectedAt = this.now()
    this.emitState()
    return this.getSnapshot()
  }

  /** Refresh the live status (Figma may have been closed or reopened). */
  async refreshStatus(): Promise<FigmaConnectionSnapshot> {
    if (this.state === 'connected' || this.state === 'degraded') {
      const probe = await this.probe()
      if (probe.ok) {
        this.state = 'connected'
        this.toolCount = probe.toolCount
        this.lastConnectedAt = this.now()
        this.lastError = undefined
      } else {
        this.state = 'degraded'
        this.lastError = probe.detail
      }
      this.emitState()
    }
    return this.getSnapshot()
  }

  async disconnect(): Promise<FigmaConnectionSnapshot> {
    removeMcpConnection(MCP_SERVER_NAME, this.mcpPaths)
    this.uninstallSkills()
    this.state = 'idle'
    this.lastError = undefined
    this.toolCount = undefined
    this.emitState()
    return this.getSnapshot()
  }

  /**
   * Copy the bundled skill trees to userData/figma-skills (references stay on
   * disk for the agent's file tools) and install each SKILL.md as a flat
   * library entry with reference links rewritten to absolute paths.
   */
  installSkills(): { ok: boolean; error?: string } {
    try {
      const sourceRoot = this.bundledSkillsRoot()
      const targetRoot = this.installedSkillsRoot()
      const libraryDir = path.join(app.getPath('userData'), 'skills')
      mkdirSync(targetRoot, { recursive: true })
      mkdirSync(libraryDir, { recursive: true })
      for (const name of SKILL_TREE_NAMES) {
        const source = path.join(sourceRoot, name)
        if (!existsSync(source)) continue
        const target = path.join(targetRoot, name)
        rmSync(target, { recursive: true, force: true })
        cpSync(source, target, { recursive: true })
        const skill = readFileSync(path.join(source, 'SKILL.md'), 'utf-8')
        writeFileSync(path.join(libraryDir, `${name}.md`), this.rewriteSkillLinks(skill, name, targetRoot), 'utf-8')
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) }
    }
  }

  private uninstallSkills(): void {
    try {
      rmSync(this.installedSkillsRoot(), { recursive: true, force: true })
      const libraryDir = path.join(app.getPath('userData'), 'skills')
      for (const name of SKILL_TREE_NAMES) {
        const flat = path.join(libraryDir, `${name}.md`)
        // Only remove files that look like ours (installed header).
        if (existsSync(flat) && readFileSync(flat, 'utf-8').startsWith('<!-- installed-by: toushou-figma-connector')) {
          rmSync(flat, { force: true })
        }
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  /**
   * Rewrite the SKILL.md for the flat library: reference links become
   * absolute paths into the installed tree; cross-links to skills that are
   * not bundled here degrade to a plain note.
   */
  rewriteSkillLinks(markdown: string, name: string, targetRoot: string): string {
    // Forward slashes keep the markdown links portable and deterministic
    // across platforms (the agent's file tools accept them on Windows too).
    const tree = path.join(targetRoot, name).split(path.sep).join('/')
    const out = markdown
      .replaceAll('](references/', `](${tree}/references/`)
      .replaceAll('](./references/', `](${tree}/references/`)
      .replace(
        /\[([^\]]+)\]\(\.\.\/figma-generate-design\/SKILL\.md\)/g,
        '$1（未随投手打包：figma-generate-design 工作流技能）'
      )
      .replace(
        /\[([^\]]+)\]\(\.\.\/figma-generate-library\/SKILL\.md\)/g,
        '$1（未随投手打包：figma-generate-library 工作流技能）'
      )
    const header =
      `<!-- installed-by: toushou-figma-connector; source-tree: ${tree} -->\n` +
      `> 投手安装说明：本技能的完整参考文档位于 \`${tree}/references/\`（含 Plugin API 类型定义，可按需 grep/读取）。\n\n`
    return header + out
  }

  private bundledSkillsRoot(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'figma-skills')
      : path.join(app.getAppPath(), 'resources', 'figma-skills')
  }

  private installedSkillsRoot(): string {
    return path.join(app.getPath('userData'), 'figma-skills')
  }

  private readMcpServers(): Record<string, unknown> {
    try {
      const file = JSON.parse(readFileSync(this.mcpPaths.mcpJson, 'utf-8')) as { mcpServers?: Record<string, unknown> }
      return file.mcpServers ?? {}
    } catch {
      return {}
    }
  }

  private async rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    return this.fetchImpl(FIGMA_MCP_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs)
    })
  }

  private snapshotStatus(): ConnectionStatus {
    switch (this.state) {
      case 'idle':
        return 'disconnected'
      case 'connecting':
        return 'connecting'
      case 'connected':
        return 'connected'
      case 'degraded':
        return 'degraded'
      case 'failed':
        return 'failed'
    }
  }

  private emitState(): void {
    const snapshot = this.getSnapshot()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.FIGMA_STATUS, snapshot)
    }
  }
}
