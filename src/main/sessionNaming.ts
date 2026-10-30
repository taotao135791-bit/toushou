import { cleanSessionName, dedupeSessionTitle } from '../shared/promptTitle'

interface LiveSession {
  id: string
  title: string
  sessionFile?: string
  resumeFrom?: string
}

/** Main-owned collaborators; keeping the queue here makes allocation testable. */
export interface SessionNamingDeps {
  getSession: (id: string) => LiveSession | undefined
  listSessions: () => LiveSession[]
  getTitles: () => Record<string, string>
  setRuntimeName: (id: string, title: string) => Promise<boolean>
  markTitle: (id: string, title: string) => string | null
  saveTitles: (titles: Record<string, string>) => void
}

/** Reserve titles before RPC and serialize each session independently. */
export function createSessionNamer(deps: SessionNamingDeps) {
  const pendingTitles = new Set<string>()
  const tails = new Map<string, Promise<void>>()
  const awaitingFile = new Map<string, { title: string; session: LiveSession }>()
  const nameSession = (sessionId: string, name: string): Promise<{ title: string } | null> => {
    const previous = tails.get(sessionId) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const clean = cleanSessionName(name)
      if (!clean) return null
      const self = deps.getSession(sessionId)
      if (!self) return null
      // A resumed session may still have an overlay on its original file as
      // well as its fork; neither is a different conversation.
      const selfFiles = new Set([self.sessionFile, self.resumeFrom].filter((file): file is string => !!file))
      const taken: string[] = [...pendingTitles]
      for (const [file, title] of Object.entries(deps.getTitles())) {
        if (!selfFiles.has(file) && typeof title === 'string') taken.push(title)
      }
      for (const session of deps.listSessions()) {
        if (session.id !== sessionId) taken.push(session.title)
      }
      const title = dedupeSessionTitle(clean, taken)
      pendingTitles.add(title)
      try {
        if (!(await deps.setRuntimeName(sessionId, title))) return null
        const file = deps.markTitle(sessionId, title)
        const live = deps.getSession(sessionId)
        if (!live) { awaitingFile.delete(sessionId); return null }
        if (file) deps.saveTitles({ ...deps.getTitles(), [file]: title })
        if (live.sessionFile) awaitingFile.delete(sessionId)
        else awaitingFile.set(sessionId, { title, session: live })
        return { title }
      } finally {
        pendingTitles.delete(title)
      }
    }).catch(() => null)
    // A failed/rejected RPC cannot poison subsequent renames for this session.
    const tail = operation.then(() => undefined)
    tails.set(sessionId, tail)
    void tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId) })
    return operation
  }

  /** Flush only names actually accepted by OMP when Main learns their file. */
  nameSession.fileAvailable = (sessionId: string, file: string): void => {
    const pending = awaitingFile.get(sessionId)
    if (!pending) return
    const live = deps.getSession(sessionId)
    if (!live || live !== pending.session || live.title !== pending.title) {
      awaitingFile.delete(sessionId)
      return
    }
    // markSessionFile intentionally refuses to replace an already known path.
    if (live.sessionFile !== file) return
    try {
      deps.saveTitles({ ...deps.getTitles(), [file]: pending.title })
      awaitingFile.delete(sessionId)
    } catch {
      // Keep the pending value so a later get_state can retry the write.
    }
  }
  return nameSession
}

/** Announce a task only after naming finishes, never resurrecting a closed session. */
export async function announceNamedTask(
  naming: Promise<{ title: string } | null>,
  isLive: () => boolean,
  fallbackTitle: string,
  announce: (title: string) => void
): Promise<void> {
  const result = await naming
  if (isLive()) announce(result?.title ?? fallbackTitle)
}
