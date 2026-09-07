import { describe, expect, it } from 'vitest'
import { CheckpointDiff } from '@shared/types'
import { turnChangesPhase } from './TurnRow'

/**
 * The undo→redo lifecycle of the per-turn change row is: normal chip →
 * (undo) → undone pill with 重做 → (redo) → back to normal chip or hidden.
 * The wiring (IPC calls, store writes, button gating) lives in the component;
 * WHICH state renders is this pure decision, so the machine is tested here —
 * there is no component interaction harness in this repo (see
 * Markdown.test.tsx, which only does static markup).
 */

function diffWithFiles(count: number): CheckpointDiff {
  return {
    files: Array.from({ length: count }, (_, i) => ({
      path: `src/file-${i}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 0
    })),
    additions: count,
    deletions: 0
  }
}

describe('turnChangesPhase (per-turn undo→redo state machine)', () => {
  it('shows the change chip when the diff has files and nothing was undone', () => {
    expect(turnChangesPhase(diffWithFiles(2), false)).toBe('normal')
  })

  it('hides when there is nothing to show', () => {
    expect(turnChangesPhase(null, false)).toBe('hidden')
    expect(turnChangesPhase(diffWithFiles(0), false)).toBe('hidden')
  })

  it('flips straight to undone after an undo, even while the diff is stale', () => {
    // Right after a successful undo the worktree matches the pre-turn
    // snapshot, but the last-fetched diff still lists the turn's files. The
    // redo target wins so the row shows 已恢复到本轮之前 + 重做 immediately.
    expect(turnChangesPhase(diffWithFiles(3), true)).toBe('undone')
  })

  it('stays undone after a remount, when the refetched diff collapses to zero', () => {
    // Redo availability survives unmount/remount via the store mapping: the
    // undone worktree diffs empty against the turn checkpoint.
    expect(turnChangesPhase(diffWithFiles(0), true)).toBe('undone')
    expect(turnChangesPhase(null, true)).toBe('undone')
  })

  it('returns to the chip or hides once a redo clears the target', () => {
    // Redo succeeded and cleared the mapping; the freshly fetched diff
    // decides — files differ again → chip, nothing differs → gone.
    expect(turnChangesPhase(diffWithFiles(1), false)).toBe('normal')
    expect(turnChangesPhase(diffWithFiles(0), false)).toBe('hidden')
  })
})
