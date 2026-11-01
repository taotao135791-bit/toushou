import { describe, expect, it } from 'vitest'
import { buildBoardHighlightsPrompt, parseBoardHighlights, type BoardHighlightEvidence } from './boardHighlights'

const proposal = { version: 1, boardId: '11111111-1111-4111-8111-111111111111', widgetId: '22222222-2222-4222-8222-222222222222', revision: `sha256:${'a'.repeat(64)}`, highlights: [{ text: 'Review this change', evidence: [{ accountIndex: 1, metric: 'spend', value: 42 }] }] }
describe('board-highlight proposal boundary', () => {
  it('accepts a strict bounded proof-carrying object', () => expect(parseBoardHighlights(JSON.stringify(proposal))).toEqual(proposal))
  it('rejects malformed, incomplete, oversized, extra-field and duplicate evidence', () => {
    for (const raw of ['{', '{}', 'x'.repeat(33000), JSON.stringify({ ...proposal, extra: 1 }), JSON.stringify({ ...proposal, boardId: 'bad' }), JSON.stringify({ ...proposal, revision: 'abc' }), JSON.stringify({ ...proposal, highlights: [] }), JSON.stringify({ ...proposal, highlights: [{ text: 'go https://example.test', evidence: proposal.highlights[0].evidence }] }), JSON.stringify({ ...proposal, highlights: [{ text: 'ok', evidence: [{ accountIndex: 1, metric: 'unknown', value: 42 }] }] }), JSON.stringify({ ...proposal, highlights: [{ text: 'ok', evidence: [{ accountIndex: 1, metric: 'spend', value: 42 }, { accountIndex: 1, metric: 'spend', value: 42 }] }] })]) expect(parseBoardHighlights(raw)).toBeNull()
  })
  it('builds a reviewable draft with account identity and whitelisted evidence', () => {
    const evidence = { boardId: proposal.boardId, widgetId: proposal.widgetId, revision: proposal.revision, capturedAt: 20, omittedCount: 0,
      accounts: [{ index: 1, platform: 'tiktok', status: 'ok', window: { start: '2026-01-01', end: '2026-01-07' }, previousWindow: null, sourceAt: 10, currency: 'USD', metrics: { spend: 42, previousSpend: null, impressions: 2, clicks: 1, conversions: 0 }, name: 'PRIVATE_NAME', accountId: 'PRIVATE_ID' }],
      rangeLabel: 'PRIVATE_RANGE' } as unknown as BoardHighlightEvidence
    const prompt = buildBoardHighlightsPrompt(evidence)
    expect(prompt).toContain('```board-highlights')
    expect(prompt).toContain('"spend":42')
    expect(prompt).toContain('PRIVATE_NAME'); expect(prompt).toContain('PRIVATE_ID')
    expect(prompt).not.toContain('PRIVATE_RANGE')
    const unknown = { ...evidence, accounts: [{ ...evidence.accounts[0], sourceAt: null }] }
    expect(buildBoardHighlightsPrompt(unknown)).toContain('"spend":null')
  })
})
