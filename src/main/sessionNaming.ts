import path from 'node:path'
import { canonicalExistingPath } from './canonicalPath'
import { cleanAutomaticSessionTitle, cleanSessionName, dedupeSessionTitle } from '../shared/promptTitle'
import type { SessionNameOptions, SessionNamingResult, SessionTitleMetadata } from '../shared/types'

interface LiveSession {
  id: string
  title: string
  cwd?: string
  sessionFile?: string
  resumeFrom?: string
  titleSource?: 'auto' | 'manual'
  titleRevision?: number
}

/** Main owns the title, its manual lock and its durable-file overlays. */
export interface SessionNamingDeps {
  getSession: (id: string) => LiveSession | undefined
  listSessions: () => LiveSession[]
  getTitles: () => Record<string, string>
  setRuntimeName: (id: string, title: string) => Promise<boolean>
  markTitle: (id: string, title: string) => string | null
  saveTitles: (titles: Record<string, string>) => void
  getMetadata?: () => Record<string, SessionTitleMetadata>
  saveMetadata?: (metadata: Record<string, SessionTitleMetadata>) => void
  markMetadata?: (id: string, metadata: SessionTitleMetadata) => void
  onTitleChanged?: (id: string, result: SessionNamingResult) => void
  normalizeFile?: (file: string) => string
}

/** Normalize aliases even when the file has just been moved to Trash. */
export function normalizeSessionTitleFile(file: string): string {
  let normalized: string
  try { normalized = canonicalExistingPath(file) }
  catch {
    try { normalized = path.join(canonicalExistingPath(path.dirname(file)), path.basename(file)) }
    catch { normalized = path.resolve(file) }
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function removeSessionTitleOverlays<T>(entries: Record<string, T>, file: string, normalizeFile: (file: string) => string = normalizeSessionTitleFile): Record<string, T> {
  const target = normalizeFile(file)
  return Object.fromEntries(Object.entries(entries).filter(([entry]) => normalizeFile(entry) !== target))
}

export interface SessionTitleOverlay { title?: string; metadata?: SessionTitleMetadata }

/** Group aliases of a single file; a manual title always outranks auto. */
export function indexSessionTitleOverlays(
  titles: Record<string, string>,
  metadata: Record<string, SessionTitleMetadata>,
  normalizeFile: (file: string) => string = file => file
): Map<string, SessionTitleOverlay> {
  const result = new Map<string, SessionTitleOverlay>()
  for (const file of new Set([...Object.keys(titles), ...Object.keys(metadata)])) {
    const raw = metadata[file]
    const valid = raw && (raw.source === 'manual' || raw.source === 'auto') && Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw : undefined
    const title = typeof titles[file] === 'string' && titles[file] ? titles[file] : undefined
    const candidate: SessionTitleOverlay = { title, metadata: valid ?? (title ? { source: 'manual', revision: 0 } : undefined) }
    if (!candidate.metadata) continue
    const key = normalizeFile(file)
    const previous = result.get(key)
    if (!previous?.metadata) { result.set(key, candidate); continue }
    const rank = (value: SessionTitleMetadata) => value.source === 'manual' ? 1 : 0
    const nextWins = rank(candidate.metadata) > rank(previous.metadata) ||
      (rank(candidate.metadata) === rank(previous.metadata) && candidate.metadata.revision > previous.metadata.revision)
    const winner = nextWins ? candidate : previous
    const other = nextWins ? previous : candidate
    result.set(key, { ...winner, title: winner.title ?? other.title })
  }
  return result
}

interface TopicState {
  session: LiveSession
  source?: 'auto' | 'manual'
  revision: number
  semanticRevision?: number
  dirty: boolean
}

/** Auto topics never wait for a control RPC that OMP can drop mid-turn. */
export function createSessionNamer(deps: SessionNamingDeps) {
  const pendingTitles = new Set<string>()
  const tails = new Map<string, Promise<void>>()
  const states = new Map<string, TopicState>()
  const awaitingFile = new Map<string, { title: string; session: LiveSession }>()

  function stateFor(sessionId: string): TopicState | undefined {
    const session = deps.getSession(sessionId)
    if (!session) { states.delete(sessionId); return undefined }
    const previous = states.get(sessionId)
    if (previous?.session === session) return previous
    const files = [session.sessionFile, session.resumeFrom].filter((file): file is string => !!file)
    const normalizeFile = deps.normalizeFile ?? ((file: string) => file)
    const overlays = indexSessionTitleOverlays(deps.getTitles(), deps.getMetadata?.() ?? {}, normalizeFile)
    const matched = files.map(file => overlays.get(normalizeFile(file))).filter((entry): entry is SessionTitleOverlay => !!entry)
    const saved = matched.find(entry => entry.metadata?.source === 'manual') ?? matched[0]
    const defaultTitle = session.cwd?.split(/[\\/]/).filter(Boolean).pop()
    // Existing names without provenance are conservatively user-owned.
    const hasExistingName = !!saved?.title || (!!defaultTitle && !!session.title.trim() && session.title !== defaultTitle && session.title !== 'Untitled')
    const source = session.titleSource === 'manual' ? 'manual' : saved?.metadata?.source ?? session.titleSource ?? (hasExistingName ? 'manual' : undefined)
    const state: TopicState = {
      session,
      source,
      revision: Math.max(saved?.metadata?.revision ?? 0, session.titleRevision ?? 0),
      dirty: false
    }
    states.set(sessionId, state)
    return state
  }

  function persist(sessionId: string, state: TopicState): void {
    if (deps.getSession(sessionId) !== state.session || !state.source) return
    const metadata = { source: state.source, revision: state.revision }
    deps.markMetadata?.(sessionId, metadata)
    // Retain a retry even if an already-known file's overlay write fails.
    awaitingFile.set(sessionId, { title: state.session.title, session: state.session })
    const files = [state.session.sessionFile, state.session.resumeFrom].filter((file): file is string => !!file)
    if (!files.length) {
      awaitingFile.set(sessionId, { title: state.session.title, session: state.session })
      return
    }
    const titles = { ...deps.getTitles() }
    const records = { ...deps.getMetadata?.() }
    const normalizeFile = deps.normalizeFile ?? ((file: string) => file)
    const aliases = new Set(files.map(normalizeFile))
    // Rewrite existing aliases of this exact file as well as the active paths;
    // unrelated overlays are preserved verbatim.
    for (const file of new Set([...files, ...Object.keys(titles), ...Object.keys(records)])) {
      if (aliases.has(normalizeFile(file))) { titles[file] = state.session.title; records[file] = metadata }
    }
    deps.saveTitles(titles)
    deps.saveMetadata?.(records)
    if (state.session.sessionFile) awaitingFile.delete(sessionId)
    else awaitingFile.set(sessionId, { title: state.session.title, session: state.session })
  }

  function allocate(sessionId: string, name: string): string {
    const self = deps.getSession(sessionId)!
    const normalizeFile = deps.normalizeFile ?? ((file: string) => file)
    const selfFiles = new Set([self.sessionFile, self.resumeFrom].filter((file): file is string => !!file).map(normalizeFile))
    const taken = [...pendingTitles]
    for (const [file, title] of Object.entries(deps.getTitles())) {
      if (!selfFiles.has(normalizeFile(file)) && typeof title === 'string') taken.push(title)
    }
    for (const session of deps.listSessions()) if (session.id !== sessionId) taken.push(session.title)
    return dedupeSessionTitle(name, taken)
  }

  function commit(sessionId: string, state: TopicState, title: string): SessionNamingResult | null {
    if (deps.getSession(sessionId) !== state.session || !state.source) return null
    deps.markTitle(sessionId, title)
    persist(sessionId, state)
    const result = { title, source: state.source, revision: state.revision }
    deps.onTitleChanged?.(sessionId, result)
    return result
  }

  const nameSession = (sessionId: string, name: string, options?: SessionNameOptions): Promise<SessionNamingResult | null> => {
    if (options?.source === 'auto') {
      const state = stateFor(sessionId)
      const clean = cleanAutomaticSessionTitle(name)
      if (!state || !clean || state.source === 'manual') return Promise.resolve(null)
      if (options.revision !== undefined && options.revision !== state.revision) return Promise.resolve(null)
      if (options.revision !== undefined && state.semanticRevision === options.revision) return Promise.resolve(null)
      // An unversioned renderer fallback can fill an empty topic only. It can
      // never replace the model's semantic topic, including a fast first turn.
      if (options.revision === undefined && state.source) return Promise.resolve(null)
      state.source = 'auto'
      state.dirty = true
      try {
        const result = commit(sessionId, state, allocate(sessionId, clean))
        if (result && options.revision !== undefined) state.semanticRevision = options.revision
        return Promise.resolve(result)
      }
      catch { return Promise.resolve(null) }
    }

    const clean = cleanSessionName(name)
    const state = stateFor(sessionId)
    if (!state || !clean) return Promise.resolve(null)
    // Lock immediately, before any pending auto tool or runtime RPC completes.
    state.source = 'manual'
    state.revision++
    deps.markMetadata?.(sessionId, { source: 'manual', revision: state.revision })
    const previous = tails.get(sessionId) ?? Promise.resolve()
    const operation = previous.then(async () => {
      if (deps.getSession(sessionId) !== state.session) return null
      const title = allocate(sessionId, clean)
      pendingTitles.add(title)
      try {
        if (!(await deps.setRuntimeName(sessionId, title))) return null
        state.dirty = false
        return commit(sessionId, state, title)
      } finally { pendingTitles.delete(title) }
    }).catch(() => null)
    const tail = operation.then(() => undefined)
    tails.set(sessionId, tail)
    void tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId) })
    return operation
  }

  nameSession.revision = (sessionId: string): number => stateFor(sessionId)?.revision ?? 0
  nameSession.forget = (sessionId: string): void => {
    states.delete(sessionId)
    awaitingFile.delete(sessionId)
    // In-flight RPCs still settle, but their live-session identity check
    // prevents a closed or replacement conversation from being mutated.
  }
  nameSession.advance = (sessionId: string): number => {
    const state = stateFor(sessionId)
    if (!state) return 0
    state.revision++
    // Update only metadata here. A failed send must not invent a new title.
    deps.markMetadata?.(sessionId, { source: state.source ?? 'auto', revision: state.revision })
    return state.revision
  }
  nameSession.runtimeIdle = (sessionId: string): void => {
    const state = stateFor(sessionId)
    if (!state?.dirty || state.source !== 'auto' || tails.has(sessionId)) return
    const title = state.session.title
    const revision = state.revision
    const operation = deps.setRuntimeName(sessionId, title).then((ok) => {
      if (ok && state.revision === revision && state.session.title === title) state.dirty = false
    }).catch(() => undefined)
    tails.set(sessionId, operation)
    void operation.then(() => { if (tails.get(sessionId) === operation) tails.delete(sessionId) })
  }
  nameSession.fileAvailable = (sessionId: string, file: string): void => {
    const pending = awaitingFile.get(sessionId)
    if (!pending) return
    const live = deps.getSession(sessionId)
    if (!live || live !== pending.session || live.title !== pending.title) {
      awaitingFile.delete(sessionId); return
    }
    if (live.sessionFile !== file) return
    const state = stateFor(sessionId)
    if (!state) return
    try { persist(sessionId, state) } catch { /* Retry when Main learns the file again. */ }
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
