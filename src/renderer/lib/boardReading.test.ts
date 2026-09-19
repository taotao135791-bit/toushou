import { describe, expect, it } from 'vitest'
import {
  boardReadingRangeDates,
  buildBoardReadingPrompt,
  buildBoardReadingUrl,
  deriveBoardReadingPhase,
  type BoardReadingLaunch,
  type BoardReadingMessageLike
} from './boardReading'

const TODAY = new Date(2026, 8, 16) // 2026-09-16, local time

describe('buildBoardReadingPrompt', () => {
  it('includes every selected metric in a fixed order', () => {
    const prompt = buildBoardReadingPrompt('三国IOS', 'last7', ['cpa', 'spend', 'cpi'])
    expect(prompt).not.toBeNull()
    expect(prompt!).toContain('「三国IOS」近7天的消耗、CPI、CPA')
    expect(prompt!.indexOf('消耗')).toBeLessThan(prompt!.indexOf('CPI'))
    expect(prompt!.indexOf('CPI')).toBeLessThan(prompt!.indexOf('CPA'))
    // Unselected metrics stay out of the request sentence; the field-mapping line may mention CPM generically.
    expect(prompt!.split('。')[0]).not.toContain('CPM')
  })

  it('embeds each date range label', () => {
    for (const [range, label] of [
      ['today', '今天'],
      ['last3', '近3天'],
      ['last30', '近30天']
    ] as const) {
      const prompt = buildBoardReadingPrompt('三国IOS', range, ['spend'])
      expect(prompt!).toContain(`「三国IOS」${label}的消耗`)
    }
  })

  it('returns null when no metric is selected', () => {
    expect(buildBoardReadingPrompt('三国IOS', 'today', [])).toBeNull()
  })

  it('carries the read-only and verified-source constraints', () => {
    const prompt = buildBoardReadingPrompt('三国IOS', 'last7', ['spend'])!
    expect(prompt).toContain('browser_report')
    expect(prompt).toContain('仅 verified=true 的结果可用')
    expect(prompt).toContain('fb_history')
    expect(prompt).toContain('禁止修改预算、出价')
    expect(prompt).toContain('未登录')
  })

  it('inline execution recipe: history-first, takeover, strict JSON envelope', () => {
    const prompt = buildBoardReadingPrompt('三国IOS', 'last7', ['spend', 'cpi'], TODAY)!
    // history-first short-circuit with a pinned account and window
    expect(prompt).toContain('fb_history 查 accountId=2131017261144314')
    expect(prompt).toContain('日期窗口=2026-09-09~2026-09-15')
    expect(prompt.indexOf('第1步')).toBeLessThan(prompt.indexOf('第2步'))
    // panel takeover so a stale owner session cannot block navigation
    expect(prompt).toContain('"takeover": true')
    // strict fence envelope to keep Apply enabled first try
    expect(prompt).toContain('"version":1')
  })

  it('embeds the canonical paired-date URL for the model to navigate verbatim', () => {
    const prompt = buildBoardReadingPrompt('三国IOS', 'last7', ['spend'], TODAY)!
    const url = buildBoardReadingUrl('三国IOS', 'last7', TODAY)
    expect(prompt).toContain(url)
    expect(url).toContain('act=2131017261144314')
    expect(url).toContain('business_id=1734414010144999')
    expect(url).toContain('date=2026-09-09_2026-09-16')
    expect(url).toContain('insights_date=2026-09-09_2026-09-16')
  })
})

describe('boardReadingRangeDates', () => {
  it('maps every range to inclusive display dates', () => {
    expect(boardReadingRangeDates('today', TODAY)).toEqual({
      start: '2026-09-16',
      end: '2026-09-16'
    })
    expect(boardReadingRangeDates('last3', TODAY)).toEqual({
      start: '2026-09-13',
      end: '2026-09-15'
    })
    expect(boardReadingRangeDates('last7', TODAY)).toEqual({
      start: '2026-09-09',
      end: '2026-09-15'
    })
    expect(boardReadingRangeDates('last30', TODAY)).toEqual({
      start: '2026-08-17',
      end: '2026-09-15'
    })
  })
})

describe('buildBoardReadingUrl', () => {
  it('always pairs date with insights_date using the same value', () => {
    const url = buildBoardReadingUrl('三国IOS', 'last3', TODAY)
    const date = /([?&])date=([^&]+)/.exec(url)?.[2]
    const insights = /([?&])insights_date=([^&]+)/.exec(url)?.[2]
    expect(date).toBeDefined()
    expect(insights).toBe(date)
  })
})

describe('deriveBoardReadingPhase', () => {
  const prompt = buildBoardReadingPrompt('三国IOS', 'last7', ['spend'])!
  const launch: BoardReadingLaunch = { sessionId: 's1', prompt, startedAt: 1 }

  const userMsg = (overrides: Partial<BoardReadingMessageLike> = {}): BoardReadingMessageLike => ({
    role: 'user',
    kind: 'prompt',
    content: prompt,
    ...overrides
  })

  it('returns null without a launch', () => {
    expect(deriveBoardReadingPhase(null, [], false)).toBeNull()
  })

  it('is pending until the prompt lands in the transcript', () => {
    expect(deriveBoardReadingPhase(launch, undefined, false)).toBe('pending')
    expect(deriveBoardReadingPhase(launch, [], false)).toBe('pending')
    expect(deriveBoardReadingPhase(launch, [userMsg({ content: '别的消息' })], false)).toBe('pending')
  })

  it('is reading while the session is busy after the message landed', () => {
    expect(deriveBoardReadingPhase(launch, [userMsg()], true)).toBe('reading')
  })

  it('is done once the turn ends with the message un-flagged', () => {
    expect(deriveBoardReadingPhase(launch, [userMsg()], false)).toBe('done')
  })

  it('is failed when the launched message is flagged', () => {
    expect(deriveBoardReadingPhase(launch, [userMsg({ failed: true })], false)).toBe('failed')
  })

  it('ignores steer messages when matching the launch prompt', () => {
    expect(deriveBoardReadingPhase(launch, [userMsg({ kind: 'steer' })], true)).toBe('pending')
  })
})
