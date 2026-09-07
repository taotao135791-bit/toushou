/**
 * 连接引导标记：技能/工具在助手回复中输出的机器可读标记行，
 * 渲染层识别后从正文剥离并就地渲染“去连接”引导卡（非阻塞）。
 * 标记必须独占一行，格式 [[connect:<kind>]]。
 */
export type ConnectionGuideKind = 'mcp' | 'feishu'

const MARKER_RE = /^\s*\[\[connect:(mcp|feishu)\]\]\s*$/gim

export const CONNECTION_MARKER_SYNTAX = '[[connect:mcp]] / [[connect:feishu]]'

export function splitConnectionMarkers(text: string): { clean: string; guides: ConnectionGuideKind[] } {
  const guides = new Set<ConnectionGuideKind>()
  const clean = String(text || '').replace(MARKER_RE, (_m, kind) => {
    guides.add(kind as ConnectionGuideKind)
    return ''
  })
  return { clean, guides: [...guides] }
}
