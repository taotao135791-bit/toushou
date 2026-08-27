/**
 * UTF-8-safe line head/tail retention for large tool outputs — adapted from the
 * byte-retention concept in DeepSeek Harness `packages/util/output-retention`
 * (TextRetainer), re-expressed for the renderer where outputs are already JS
 * strings.
 *
 * Copyright (c) 2026 DeepSeek
 * MIT License — see THIRD_PARTY_NOTICES.md.
 *
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Modifications: the upstream retainer is byte-oriented (process/body safety);
 * the renderer already holds a decoded string, so this adapter splits on line
 * boundaries — which is UTF-8-safe by construction (JS strings split on `\n`
 * never cut a multi-byte codepoint) — and reports the hidden line count rather
 * than an omitted-byte count.
 */

export interface HeadTail {
  /** The retained head lines (at most `headLines`). */
  head: string
  /** The retained tail lines (at most `tailLines`, only when truncation happened). */
  tail: string
  /** Number of hidden units (lines or chars) between head and tail. */
  hidden: number
  /** The unit `hidden` counts in. */
  hiddenUnit: 'lines' | 'chars'
  /** True when any content was omitted. */
  truncated: boolean
}

/** Split a string into lines, preserving trailing content exactly. */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  // A trailing '' from a final newline is a real empty last line; keep it only
  // if the source actually ended with a newline (so round-tripping is exact).
  return lines
}

/**
 * Keep the first `headLines` and last `tailLines` lines of a potentially huge
 * tool output, with an exact hidden-line count. When the input fits inside the
 * budget, `head` is the whole text, `tail` is empty and `truncated` is false —
 * callers render the full text in that case.
 */
export function headTailLines(text: string, headLines: number, tailLines: number): HeadTail {
  const lines = splitLines(text)
  const total = lines.length
  const keepHead = Math.max(0, headLines)
  const keepTail = Math.max(0, tailLines)

  if (total <= keepHead + keepTail) {
    return { head: text, tail: '', hidden: 0, hiddenUnit: 'lines', truncated: false }
  }

  const head = lines.slice(0, keepHead).join('\n')
  const tail = lines.slice(total - keepTail).join('\n')
  return {
    head,
    tail,
    hidden: total - keepHead - keepTail,
    hiddenUnit: 'lines',
    truncated: true
  }
}

/** A UTF-16 high surrogate (first half of an emoji / astral codepoint). */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** A UTF-16 low surrogate (second half of an emoji / astral codepoint). */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Drop a trailing lone high surrogate so a char cut never splits an astral codepoint. */
function trimTrailingHighSurrogate(s: string): string {
  if (s.length && isHighSurrogate(s.charCodeAt(s.length - 1))) return s.slice(0, -1)
  return s
}

/** Drop a leading lone low surrogate so a char cut never splits an astral codepoint. */
function trimLeadingLowSurrogate(s: string): string {
  if (s.length && isLowSurrogate(s.charCodeAt(0))) return s.slice(1)
  return s
}

/**
 * Char-based head/tail retention for content that is large by SIZE, not by line
 * count (e.g. a single 4 MB minified JSON line). Cuts are surrogate-safe — an
 * emoji spanning two UTF-16 code units is never split in half.
 */
export function headTailChars(text: string, headChars: number, tailChars: number): HeadTail {
  const total = text.length
  const keepHead = Math.max(0, headChars)
  const keepTail = Math.max(0, tailChars)
  if (total <= keepHead + keepTail) {
    return { head: text, tail: '', hidden: 0, hiddenUnit: 'chars', truncated: false }
  }
  const head = trimTrailingHighSurrogate(text.slice(0, keepHead))
  const tail = trimLeadingLowSurrogate(text.slice(total - keepTail))
  return {
    head,
    tail,
    hidden: total - head.length - tail.length,
    hiddenUnit: 'chars',
    truncated: true
  }
}

/** True when content is large by line count OR by character count. */
export function isLargeText(text: string, lineThreshold: number, charThreshold: number): boolean {
  if (!text) return false
  const lineCount = text.replace(/\n$/, '').split('\n').length
  if (lineCount > lineThreshold) return true
  return text.length > charThreshold
}
