/**
 * Shared session-title helpers. summarizePromptTitle turns a user's first
 * prompt into a sidebar-friendly title; cleanSessionName is the ONE
 * normalization rule omp, the durable overlay and the rename UI all follow,
 * so their stored values can never drift apart.
 */

/** Keep the 60 UTF-16 unit OMP limit without splitting a surrogate pair. */
function takeUtf16(value: string, limit: number): string {
  let result = ''
  for (const character of value) {
    if (result.length + character.length > limit) break
    result += character
  }
  return result
}

/** Durable session names: collapse whitespace and cap at 60 UTF-16 units. */
export function cleanSessionName(name: string): string {
  return takeUtf16(name.replace(/\s+/g, ' ').trim(), 60)
}

/** Sidebar metadata must never become a second place to expose credentials or IDs. */
export function cleanAutomaticSessionTitle(text: string): string {
  return cleanSessionName(text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|密钥|密码)\s*[=:：]?\s*["']?[^\s,，;；"']+/gi, ' ')
    .replace(/\bBearer\s+\S+/gi, ' ')
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/gi, ' ')
    .replace(/https?:\/\/[^\s㐀-鿿　-〿＀-￯]+/gi, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, ' ')
    .replace(/\b[0-9a-f]{16,}\b/gi, ' ')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, ' ')
    .replace(/\b\d{3}[- ]\d{3}[- ]\d{4}\b/g, ' ')
    .replace(/\b(?:advertiser|account|customer|client)[_ -]?id\s*[:=：]?\s*[A-Za-z0-9_-]+/gi, ' ')
    .replace(/\d{6,}/g, ' ')
    .replace(/(?:广告主|advertiser|account|账户|账号)\s*(?:id|ID|编号)?\s*[:：#=]?\s*(?=$|[，,。;；])/gi, ' ')
    .replace(/^[\s:：,，;；\-–—]+|[\s:：,，;；\-–—]+$/g, ' '))
}

/**
 * Auto-names collide often (same task run twice, same first prompt). Return
 * the candidate unchanged when free, else append " 2", " 3", … while staying
 * inside the 60-char cap (the base is shortened, never the number).
 */
export function dedupeSessionTitle(candidate: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(candidate)) return candidate
  // Each candidate uses a distinct suffix, so there is always a free one
  // after at most used.size + 1 attempts.
  for (let n = 2; n <= used.size + 2; n++) {
    const suffix = ` ${n}`
    const base = takeUtf16(candidate, 60 - suffix.length).trimEnd()
    const next = `${base}${suffix}`
    if (!used.has(next)) return next
  }
  throw new Error('Could not allocate a unique session title')
}

/**
 * Heuristic session-title summary of a user's first prompt: strips markdown
 * structure, collapses URLs (they name nothing at sidebar width), prefers
 * the first natural clause and caps the result for the sidebar column.
 * urlLabel localizes the URL placeholder (链接 / link).
 */
export function summarizePromptTitle(text: string, urlLabel = 'link'): string {
  let t = cleanAutomaticSessionTitle(text.replace(/https?:\/\/[^\s㐀-鿿　-〿＀-￯]+/g, urlLabel))
    // Fenced code blocks carry no title value; inline code keeps its text.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    // A leading slash command is a mode, not a topic.
    .replace(/^\s*\/\S+\s*/, ' ')
    // URLs stop before CJK text/punctuation — \S+ would otherwise swallow
    // the whole unspaced Chinese run that follows the address.
    .replace(/https?:\/\/[^\s㐀-鿿　-〿＀-￯]+/g, urlLabel)
    // Markdown emphasis/heading noise. Underscores stay: snake_case
    // identifiers are more common in prompts than _emphasis_.
    .replace(/[*~#>]+/g, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const zh = urlLabel === '链接' || /[\u3400-\u9fff]/.test(t)
  // Start with an intent, rather than a slice of "please help me…". The
  // active conversation model refines this local fallback in the same turn.
  const platform = /\b(?:tiktok|tt)\b/i.test(t) ? 'TikTok' : /\b(?:facebook|meta|fb)\b/i.test(t) ? 'FB' : /谷歌|\bgoogle\b/i.test(t) ? 'Google' : ''
  if (/看板|dashboard/i.test(t) && /新建|建立|生成|创建|保存|create|build|save/i.test(t)) return zh ? `${platform}读数看板` : `${platform ? `${platform} ` : ''}Reading dashboard`
  if (/巡检|检查账户|account\s+(?:audit|review)/i.test(t)) return zh ? `${platform}账户巡检` : `${platform ? `${platform} ` : ''}Account review`
  if (platform && /分析|诊断|为什么|analysis|analy[sz]e|diagnos/i.test(t)) return zh ? `${platform}投放分析` : `${platform} performance analysis`
  if (/预算|budget/i.test(t) && /分析|分配|调整|规划|allocation|plan|review/i.test(t)) return zh ? '预算规划与分析' : 'Budget planning'
  if (/api[_ -]?key|模型|model|deepseek|provider/i.test(t) && /配置|设置|连接|选择|用|config|setup|connect|select/i.test(t)) return zh ? '模型连接配置' : 'Model setup'
  // Leading request filler names nothing: strip stacked openers (请帮我看看 →
  // the actual topic). Anchored, so 帮我 mid-sentence is never touched.
  for (let i = 0; i < 3; i++) {
    const next = t
      .replace(/^(请你|麻烦你|请|麻烦)[ ,，]*/, '')
      .replace(/^(帮我|帮忙|help me|please|can you|could you)[ ,，，]*/i, '')
      .replace(/^(看看|看一下|瞅一下|处理一下|弄一下|搞一下)[ ,，]*/, '')
      .trim()
    if (next === t) break
    t = next
  }
  if (!t) return ''
  // Prefer the first natural clause (fullwidth ，、 break clauses too);
  // a degenerate split (e.g. "3.5") falls back to the whole text instead
  // of naming the session "3".
  const clause = t.split(/[。！？，、!?;\n]/)[0].trim()
  const base = clause.length >= 2 ? clause : t
  // Cap by code points so an emoji never gets sliced into a lone surrogate.
  const chars = Array.from(base)
  return chars.length > 24 ? `${chars.slice(0, 24).join('').trimEnd()}…` : base
}
