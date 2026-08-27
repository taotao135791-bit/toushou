/**
 * Tracks asynchronous work that belongs to one workspace. IPC calls cannot be
 * cancelled once they have crossed the preload boundary, so consumers keep a
 * request token and ignore a result unless it still belongs to the current
 * workspace and is the latest request for that key.
 */
export interface WorkspaceRequestToken {
  workspaceId: string
  workspaceGeneration: number
  key: string
  requestGeneration: number
}

export class WorkspaceRequestFence {
  private workspaceId: string | null = null
  private workspaceGeneration = 0
  private requestGenerations = new Map<string, number>()

  /**
   * Call during render with the active workspace id. Returning to a workspace
   * after visiting another one creates a new generation, so late results from
   * the earlier visit cannot populate the new view.
   */
  setWorkspace(workspaceId: string | null): void {
    if (this.workspaceId === workspaceId) return
    this.workspaceId = workspaceId
    this.workspaceGeneration += 1
    this.requestGenerations.clear()
  }

  /** Start a request. Requests sharing a key supersede each other. */
  begin(workspaceId: string, key: string): WorkspaceRequestToken {
    this.setWorkspace(workspaceId)
    const requestGeneration = (this.requestGenerations.get(key) ?? 0) + 1
    this.requestGenerations.set(key, requestGeneration)
    return {
      workspaceId,
      workspaceGeneration: this.workspaceGeneration,
      key,
      requestGeneration
    }
  }

  /** True only while this is still the latest request for the active workspace. */
  isCurrent(token: WorkspaceRequestToken): boolean {
    return (
      this.workspaceId === token.workspaceId &&
      this.workspaceGeneration === token.workspaceGeneration &&
      this.requestGenerations.get(token.key) === token.requestGeneration
    )
  }

  /** Make any outstanding request for a key stale without starting a new one. */
  invalidate(key: string): void {
    this.requestGenerations.set(key, (this.requestGenerations.get(key) ?? 0) + 1)
  }
}
