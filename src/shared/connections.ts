/** Public, secret-free connection contracts shared by Main and Renderer. */

export type ConnectionKind = 'mcp' | 'channel' | 'oauth' | 'native'

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'waiting_for_user'
  | 'connected'
  | 'degraded'
  | 'needs_attention'
  | 'failed'

export type FeishuConnectState =
  | 'idle'
  | 'starting_registration'
  | 'waiting_for_scan'
  | 'registration_confirmed'
  | 'storing_credentials'
  | 'configuring_app'
  | 'starting_channel'
  | 'probing'
  | 'connected'
  | 'degraded'
  | 'needs_admin_approval'
  | 'unsupported_registration'
  | 'failed'

export type LarkBrand = 'feishu' | 'lark'

export type FeishuCapability =
  | 'messaging'
  | 'docs.read'
  | 'docs.write'
  | 'sheets.read'
  | 'sheets.write'
  | 'bitable.read'
  | 'bitable.write'
  | 'calendar.read'
  | 'calendar.write'
  | 'tasks'
  | 'drive'

export interface ConnectionDefinition {
  id: string
  kind: ConnectionKind
  label: string
  description: string
  capabilities: FeishuCapability[] | string[]
}

export interface FeishuRegistrationView {
  verificationUri: string
  verificationUriComplete: string
  userCode?: string
  expiresAt: number
}

export interface FeishuConnectionSnapshot {
  definition: ConnectionDefinition
  status: ConnectionStatus
  state: FeishuConnectState
  connected: boolean
  appIdMasked?: string
  tenantBrand?: LarkBrand
  botName?: string
  botOpenId?: string
  lastError?: string
  lastConnectedAt?: number
  lastMessageAt?: number
  lastReconnectAt?: number
  websocketState?: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'
  authorizedCapabilities: FeishuCapability[]
}

export type FeishuConnectionResult =
  | { ok: true; snapshot: FeishuConnectionSnapshot; registration?: FeishuRegistrationView }
  | { ok: false; error: string; snapshot: FeishuConnectionSnapshot }

export interface FeishuOAuthAuthorizationView {
  verificationUri: string
  verificationUriComplete: string
  expiresAt: number
  capability: FeishuCapability
}

export type FeishuOAuthBeginResult =
  | { ok: true; authorization: FeishuOAuthAuthorizationView; snapshot: FeishuConnectionSnapshot }
  | { ok: false; error: string; snapshot: FeishuConnectionSnapshot }

export interface FeishuManualCredentials {
  appId: string
  appSecret: string
  brand: LarkBrand
}

export interface FeishuToolRequest {
  action:
    | 'message_send'
    | 'message_reply'
    | 'message_read'
    | 'message_search'
    | 'doc_list'
    | 'doc_search'
    | 'doc_read'
    | 'doc_create'
    | 'doc_append'
    | 'sheets_read'
    | 'sheets_write'
    | 'sheets_create'
    | 'bitable_read'
    | 'bitable_upsert'
    | 'bitable_query'
  [key: string]: unknown
}

export interface FeishuToolResult {
  ok: boolean
  data?: unknown
  error?: string
  authorizationRequired?: FeishuCapability
}

/* ---------- MCP 服务连接（投手作为配置管家写入运行时原生 mcp.json） ---------- */

export type McpTransport = 'http' | 'sse' | 'stdio'

/** 渲染层可见的 MCP 服务器条目（端点脱敏，令牌永不出主进程）。 */
export interface McpConnectionInfo {
  name: string
  transport: McpTransport
  endpointMasked: string
  /** true = 由投手连接页添加（可在此移除）；false = 用户手写，投手不碰。 */
  managed: boolean
  enabled: boolean
}

/** 添加输入：粘贴整段 JSON，或表单三件套（名称 + 地址 + 令牌）。 */
export interface McpAddInput {
  name?: string
  url?: string
  token?: string
  headerName?: string
  rawJson?: string
}

export type McpMutationResult = { ok: true; name: string } | { ok: false; error: string }

export interface McpTestOutcome {
  ok: boolean
  detail: string
}
