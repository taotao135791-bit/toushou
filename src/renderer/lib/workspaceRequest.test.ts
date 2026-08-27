import { describe, expect, it } from 'vitest'
import { WorkspaceRequestFence } from './workspaceRequest'

describe('WorkspaceRequestFence', () => {
  it('drops a response after changing workspaces, including when returning to the first workspace', () => {
    const fence = new WorkspaceRequestFence()
    fence.setWorkspace('workspace-a')
    const firstVisit = fence.begin('workspace-a', 'tree:root')

    fence.setWorkspace('workspace-b')
    expect(fence.isCurrent(firstVisit)).toBe(false)

    fence.setWorkspace('workspace-a')
    expect(fence.isCurrent(firstVisit)).toBe(false)
  })

  it('keeps independent requests but supersedes an older request for the same key', () => {
    const fence = new WorkspaceRequestFence()
    fence.setWorkspace('workspace-a')
    const firstDiff = fence.begin('workspace-a', 'diff')
    const treeNode = fence.begin('workspace-a', 'tree:src')
    const secondDiff = fence.begin('workspace-a', 'diff')

    expect(fence.isCurrent(firstDiff)).toBe(false)
    expect(fence.isCurrent(treeNode)).toBe(true)
    expect(fence.isCurrent(secondDiff)).toBe(true)
  })

  it('can invalidate an outstanding request when its UI is closed', () => {
    const fence = new WorkspaceRequestFence()
    fence.setWorkspace('workspace-a')
    const request = fence.begin('workspace-a', 'tree:src')

    fence.invalidate('tree:src')

    expect(fence.isCurrent(request)).toBe(false)
  })
})
