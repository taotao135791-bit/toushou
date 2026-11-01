/** A display-only summary. The original request and option values remain authoritative. */
export interface ApprovalDisplaySummary { title: string; targetLabel: string; target: string }

/** Recognize only the runtime's exact write-approval envelope and known actions. */
export function approvalDisplaySummary(method: string, title: string, message: string | undefined, language: 'zh' | 'en'): ApprovalDisplaySummary | null {
  if (method !== 'select' && method !== 'confirm') return null
  const zh = language === 'zh'
  for (const source of [title, message ?? '']) {
    const match = /^Allow tool: write\r?\nPath: ([^\r\n]+)\r?\nContent:[ \t]*(?:\r?\n)?([\s\S]*)$/.exec(source)
    if (!match) continue
    const path = match[1]
    const content = match[2]
    if (!path.startsWith('xd://')) {
      if (/[\x00-\x1f\x7f]/.test(path) || !/\.html$/i.test(path)) continue
      const filename = path.split(/[\\/]/).pop()
      if (!filename) continue
      return { title: zh ? '保存 HTML 文件' : 'Save HTML file', targetLabel: zh ? '文件' : 'File', target: filename }
    }
    if (path !== 'xd://toushou_board_create' && path !== 'xd://toushou_board_add_widget') continue
    let value: unknown
    try { value = JSON.parse(content) } catch { continue }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const object = value as Record<string, unknown>
    const text = (v: unknown) => typeof v === 'string' && v.trim() && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v) ? v : ''
    if (path === 'xd://toushou_board_create') {
      const name = text(object.name)
      if (!name) continue
      return { title: zh ? '新建看板' : 'Create board', targetLabel: zh ? '看板' : 'Board', target: name }
    }
    const kind = text(object.type), board = text(object.name) || text(object.boardId)
    const labels: Record<string, [string, string]> = {
      file:['文件','File'], note:['便签','Note'], clock:['时钟','Clock'], counter:['指标卡','Metric'],
      'fb-reading':['Facebook 读数','Facebook reading'], 'fb-reading-summary':['Facebook 读数汇总','Facebook summary'],
      'fb-report-reading':['Facebook 报表','Facebook report'], 'google-report-reading':['Google 报表','Google report'],
      'tt-reading':['TikTok 读数','TikTok reading'], gauge:['仪表','Gauge'], 'chart-line':['折线图','Line chart'],
      'chart-bar':['柱状图','Bar chart'], todo:['待办','To-do'], link:['链接','Link']
    }
    if (!Object.hasOwn(labels,kind) || !board) continue
    return { title: zh ? '添加组件' : 'Add widget', targetLabel: zh ? '看板 / 组件' : 'Board / widget', target: `${board} / ${labels[kind][zh ? 0 : 1]}` }
  }
  return null
}
