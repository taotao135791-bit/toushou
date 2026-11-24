export type SessionImportSource = 'codex' | 'claude'

export type SessionImportResult =
  | {
      ok: true
      imported: number
      duplicates: number
      skipped: number
      failed: number
      defaultWorkspace: number
      compressed: number
    }
  | { ok: false; error: 'cancelled' | 'busy' | 'invalid-request' | 'source-unavailable' | 'destination-unavailable' | 'import-failed' }
