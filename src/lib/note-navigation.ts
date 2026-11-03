import type { SearchableRecord } from './note-search'

export type NoteNavigation = { pinned: string[]; recent: string[] }
export const MAX_PINNED_NOTES = 2_000
export const MAX_RECENT_NOTES = 200
const MAX_STORED_LENGTH = 200_000
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id)
const ids = (value: unknown, limit: number): string[] => Array.isArray(value) ? [...new Set(value.filter(validId))].slice(0, limit) : []
function clean(value: unknown): NoteNavigation {
  const input = value && typeof value === 'object' ? value as Partial<NoteNavigation> : {}
  return { pinned: ids(input.pinned, MAX_PINNED_NOTES), recent: ids(input.recent, MAX_RECENT_NOTES) }
}
function storageKey(scope: string) {
  if (!/^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9_-]{1,128}$/.test(scope)) throw new Error('Invalid notebook navigation scope.')
  return `pubky-notes:navigation:${scope}`
}

/** Store identifiers only. Private titles, content, queries and other accounts'
 * navigation never belong in these preferences. Storage denial is nonfatal. */
export function readNoteNavigation(scope: string): NoteNavigation {
  try {
    const raw = localStorage.getItem(storageKey(scope))
    if (!raw || raw.length > MAX_STORED_LENGTH) return clean(null)
    const value = JSON.parse(raw)
    return value?.version === 1 ? clean(value) : clean(null)
  } catch { return clean(null) }
}
export function writeNoteNavigation(scope: string, preferences: NoteNavigation): boolean {
  try {
    const value = clean(preferences)
    localStorage.setItem(storageKey(scope), JSON.stringify({ version: 1, ...value }))
    return true
  } catch { return false }
}
export function toggleNotePin(preferences: NoteNavigation, id: string): NoteNavigation {
  const value = clean(preferences)
  if (!validId(id)) return value
  return { ...value, pinned: value.pinned.includes(id) ? value.pinned.filter(current => current !== id) : [id, ...value.pinned].slice(0, MAX_PINNED_NOTES) }
}
export function rememberNote(preferences: NoteNavigation, id: string): NoteNavigation {
  const value = clean(preferences)
  return validId(id) ? { ...value, recent: [id, ...value.recent.filter(current => current !== id)].slice(0, MAX_RECENT_NOTES) } : value
}
export function sortNavigableNotes<T extends SearchableRecord>(records: readonly T[], preferences: NoteNavigation, sort: 'recent' | 'title' = 'recent'): T[] {
  const value = clean(preferences)
  const pinned = new Map(value.pinned.map((id, index) => [id, index]))
  const recent = new Map(value.recent.map((id, index) => [id, index]))
  return records.filter(row => !row.note.deleted).sort((left, right) => {
    const a = left.note, b = right.note
    const pinOrder = Number(pinned.has(b.id)) - Number(pinned.has(a.id))
    if (pinOrder) return pinOrder
    if (sort === 'title') return a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
    if (pinned.has(a.id) && pinned.has(b.id)) return pinned.get(a.id)! - pinned.get(b.id)!
    const recentOrder = (recent.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (recent.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    if (recentOrder) return recentOrder
    return (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
  })
}
