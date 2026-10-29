/**
 * Shared session-title helpers. summarizePromptTitle turns a user's first
 * prompt into a sidebar-friendly title; cleanSessionName is the ONE
 * normalization rule omp, the durable overlay and the rename UI all follow,
 * so their stored values can never drift apart.
 */

/** Durable session names: collapse whitespace, cap at 60 (omp's own limit). */
export function cleanSessionName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 60)
}

/**
 * Auto-names collide often (same task run twice, same first prompt). Return
 * the candidate unchanged when free, else append " 2", " 3", … while staying
 * inside the 60-char cap (the base is shortened, never the number).
 */
export function dedupeSessionTitle(candidate: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(candidate)) return candidate
  for (let n = 2; n < 100; n++) {
    const suffix = ` ${n}`
    const base = Array.from(candidate).slice(0, 60 - suffix.length).join('').trimEnd()
    const next = `${base}${suffix}`
    if (!used.has(next)) return next
  }
  return candidate
}

/**
 * Heuristic session-title summary of a user's first prompt: strips markdown
 * structure, collapses URLs (they name nothing at sidebar width), prefers
 * the first natural clause and caps the result for the sidebar column.
 * urlLabel localizes the URL placeholder (链接 / link).
 */
export function summarizePromptTitle(text: string, urlLabel = 'link'): string {
  let t = text
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
