import type { DingTalkToolRequest, DingTalkWriteRequest } from '../../../shared/connections'
import { getWorkspaceOperation, parseWorkspaceArgs } from './workspaceOperations'

const NODE_ID = /^[A-Za-z0-9_-]{1,200}$/

export function isDingTalkNodeId(value: unknown): value is string {
  return typeof value === 'string' && NODE_ID.test(value)
}

export function parseNode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null
  const text = value.trim()
  if (isDingTalkNodeId(text)) return text
  try {
    const url = new URL(text)
    if (url.origin !== 'https://alidocs.dingtalk.com' || url.username || url.password) return null
    return /^\/i\/nodes\/([A-Za-z0-9_-]{1,200})\/?$/.exec(url.pathname)?.[1] ?? null
  } catch {
    return null
  }
}

function singleLine(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)) return null
  return value.trim() || null
}

function validContent(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64_000 && !!value.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)
}

export function isDingTalkWrite(request: DingTalkToolRequest): request is DingTalkWriteRequest {
  return request.action === 'create_document' || request.action === 'append_document' || request.action === 'workspace_write'
}

export function parseDingTalkRequest(raw: unknown): DingTalkToolRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const keys = Object.keys(input)
  switch (input.action) {
    case 'workspace_catalog': {
      if (keys.some(key => !['action', 'service', 'operation', 'cursor'].includes(key))) return null
      const request: Extract<DingTalkToolRequest, { action: 'workspace_catalog' }> = { action: input.action }
      if ('service' in input) {
        if (typeof input.service !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(input.service)) return null
        request.service = input.service
      }
      if ('operation' in input) {
        if (typeof input.operation !== 'string' || input.operation.length > 200 || !getWorkspaceOperation(input.operation)) return null
        if (request.service && !input.operation.startsWith(request.service + '.')) return null
        request.operation = input.operation
      }
      if ('cursor' in input) {
        if (typeof input.cursor !== 'number' || !Number.isSafeInteger(input.cursor) || input.cursor < 0 || input.cursor > 100_000) return null
        request.cursor = input.cursor
      }
      return request
    }
    case 'workspace_read':
    case 'workspace_write': {
      if (keys.length !== 3 || typeof input.operation !== 'string' || input.operation.length > 200) return null
      const operation = getWorkspaceOperation(input.operation)
      if (!operation || (operation.effect === 'read') !== (input.action === 'workspace_read')) return null
      const args = parseWorkspaceArgs(input.operation, input.args)
      if (!args) return null
      if (input.operation === 'doc.update') {
        const node = parseNode(args.node)
        if (!node) return null
        args.node = node
      }
      return { action: input.action, operation: input.operation, args }
    }
    case 'search_messages':
    case 'search_documents': {
      const query = singleLine(input.query)
      return keys.length === 2 && query ? { action: input.action, query } : null
    }
    case 'read_document': {
      const documentId = parseNode(input.documentId)
      return keys.length === 2 && documentId ? { action: input.action, documentId } : null
    }
    case 'create_document': {
      if (keys.some(key => !['action', 'title', 'content', 'folderId'].includes(key))) return null
      const title = singleLine(input.title)
      if (!title) return null
      const request: DingTalkWriteRequest = { action: input.action, title }
      if ('folderId' in input) {
        const folderId = parseNode(input.folderId)
        if (!folderId) return null
        request.folderId = folderId
      }
      if ('content' in input) {
        if (!validContent(input.content)) return null
        request.content = input.content
      }
      return request
    }
    case 'append_document': {
      const documentId = parseNode(input.documentId)
      return keys.length === 3 && documentId && validContent(input.content)
        ? { action: input.action, documentId, content: input.content } : null
    }
    default: return null
  }
}
