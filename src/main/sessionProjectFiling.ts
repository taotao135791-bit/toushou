import { getStore, setStore } from './store'

/** Display-only keys. The owning workspace is never resolved as a path here. */
export function sidebarConversationIdentity(value: unknown): [string, string] | undefined {
  if (typeof value !== 'string' || value.length > 16384) return
  try {
    const pair: unknown = JSON.parse(value)
    if (Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string' && part.length > 0)) return [pair[0], pair[1]]
  } catch { return undefined }
}

/** Main serializes a single record update so unrelated assignments made from
 * different windows cannot overwrite each other. */
export function fileSidebarConversation(key: unknown, projectId: unknown, previousKey: unknown, migrateOnly: unknown, isAvailable: (id: string) => boolean): boolean {
  if (typeof key !== 'string' || !sidebarConversationIdentity(key) || (previousKey !== undefined && (typeof previousKey !== 'string' || !sidebarConversationIdentity(previousKey)))) return false
  if (projectId !== null && (typeof projectId !== 'string' || !isAvailable(projectId))) return false
  const assignments = { ...getStore('sidebarSessionProjects') }
  // A late live→durable handoff must not undo a more recent user drop.
  if (migrateOnly && (!previousKey || assignments[previousKey] !== projectId || assignments[key] !== undefined)) return false
  if (previousKey && previousKey !== key) delete assignments[previousKey]
  if (projectId === null) delete assignments[key]
  else assignments[key] = projectId
  setStore('sidebarSessionProjects', assignments)
  return true
}
