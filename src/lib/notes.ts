import { PubkyResource, PublicKey } from '@synonymdev/pubky'
import type { Address, Path, Session, StorageLock } from '@synonymdev/pubky'
import { APP_PATHS, LEGACY_PATHS } from '../config'
import { getPubky } from './pubky'
import { normalizeFolder } from './folders'

export interface Note {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  folder?: string
}

export interface NoteRecord {
  note: Note
  published: Note | null
}

export const MAX_NOTE_BYTES = 512 * 1024
export const MAX_CONTENT_LENGTH = 250_000
const MAX_TITLE_LENGTH = 200
const LIST_PAGE_SIZE = 100
const MAX_NOTES = 2_000
const DOWNLOAD_CONCURRENCY = 5
const MIGRATION_LOCK_SECONDS = 60
type StorageSpace = keyof typeof APP_PATHS

export function createNote(): Note {
  const now = new Date().toISOString()
  return { id: crypto.randomUUID(), title: 'Untitled note', content: '', createdAt: now, updatedAt: now }
}

export function notePath(space: StorageSpace, id: string): Path {
  requireId(id)
  return `${APP_PATHS[space]}${id}.json`
}

export async function listNotes(session: Session): Promise<NoteRecord[]> {
  await migrateLegacyNotes(session)
  const [privateNotes, publicNotes] = await Promise.all([
    readFolder(session, 'private'),
    readFolder(session, 'public'),
  ])
  const published = new Map(publicNotes.map((note) => [note.id, note]))
  const canonical = new Map(privateNotes.map((note) => [note.id, note]))
  // Keep public files discoverable even if another app removed their private original.
  for (const note of publicNotes) if (!canonical.has(note.id)) canonical.set(note.id, note)
  return [...canonical.values()]
    .map((note) => ({ note, published: published.get(note.id) ?? null }))
    .sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt))
}

export async function saveNote(session: Session, note: Note): Promise<Note> {
  const saved = validateNote(note, note.id)
  await session.storage.putJson(notePath('private', saved.id), saved)
  return saved
}

export async function publishNote(session: Session, note: Note): Promise<Note> {
  // Publishing is always explicit. Ordinary edits update the private original only.
  const saved = await saveNote(session, note)
  const snapshot = publicSnapshot(saved)
  await session.storage.putJson(notePath('public', saved.id), snapshot)
  return snapshot
}

export async function unpublishNote(session: Session, id: string): Promise<void> {
  const privatePath = notePath('private', id)
  if (!await session.storage.exists(privatePath)) {
    // A legacy private draft always takes precedence over a public snapshot.
    const original = await readOptionalNote(session, legacyPath('private', id), id)
      ?? await readOptionalNote(session, notePath('public', id), id)
      ?? await readOptionalNote(session, legacyPath('public', id), id)
    if (original) await saveNote(session, original)
  }
  // Report success only once neither old nor new public copies remain.
  await deleteIfPresent(session, notePath('public', id))
  await deleteIfPresent(session, legacyPath('public', id))
}

export async function deleteNote(session: Session, id: string): Promise<void> {
  // Keep the original if either public deletion fails. Remove legacy private data
  // before the current draft so a failed cleanup cannot resurrect a deleted note.
  await deleteIfPresent(session, notePath('public', id))
  await deleteIfPresent(session, legacyPath('public', id))
  await deleteIfPresent(session, legacyPath('private', id))
  await deleteIfPresent(session, notePath('private', id))
}

export async function loadPublicNote(owner: string, id: string): Promise<Note> {
  requireId(id)
  const publicKey = PublicKey.from(owner)
  try {
    const read = async (folder: typeof APP_PATHS.public | typeof LEGACY_PATHS.public) => {
      const address: Address = `pubky${publicKey.z32()}${folder}${id}.json`
      const response = await getPubky().publicStorage.get(address)
      return publicSnapshot(validateNote(await readBoundedJson(response), id))
    }
    try { return await read(APP_PATHS.public) } catch (error) {
      if (!isMissing(error)) throw error
      return await read(LEGACY_PATHS.public)
    }
  } finally {
    publicKey.free()
  }
}

function legacyPath(space: StorageSpace, id: string): Path {
  requireId(id)
  return `${LEGACY_PATHS[space]}${id}.json`
}

function publicSnapshot(note: Note): Note {
  const { folder: _folder, ...snapshot } = note
  return snapshot
}

async function readOptionalNote(session: Session, path: Path, id: string): Promise<Note | null> {
  try { return validateNote(await readBoundedJson(await session.storage.get(path)), id) } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function migrateLegacyNotes(session: Session): Promise<void> {
  for (const space of ['private', 'public'] as const) {
    const ids = await listIds(session, LEGACY_PATHS[space])
    // Migrate snapshots independently: a private draft must never become public.
    for (const id of ids) await migrateLegacyNote(session, space, id)
  }
}

async function migrateLegacyNote(session: Session, space: StorageSpace, id: string): Promise<void> {
  const sourcePath = legacyPath(space, id)
  const destinationPath = notePath(space, id)
  const locks: StorageLock[] = []
  try {
    // Reserving both paths prevents another device from overwriting either copy
    // between the comparison, write, verification, and source removal.
    const sourceLock = await session.storage.lock(sourcePath, MIGRATION_LOCK_SECONDS)
    locks.push(sourceLock)
    const destinationLock = await session.storage.lock(destinationPath, MIGRATION_LOCK_SECONDS)
    locks.push(destinationLock)
    const original = await readOptionalNote(session, sourcePath, id)
    if (!original) return
    const copy = space === 'public' ? publicSnapshot(original) : original
    const existing = await readOptionalNote(session, destinationPath, id)
    if (existing && !sameNote(existing, copy)) {
      const error = new Error(`Could not move “${original.title || id}”: different notes already exist at ${sourcePath} and ${destinationPath}. Both copies are preserved. Export or rename one copy before retrying.`)
      error.name = 'NotesMigrationConflictError'
      throw error
    }
    if (!existing) {
      await session.storage.refreshLock(sourceLock, MIGRATION_LOCK_SECONDS)
      await session.storage.putTextLocked(destinationLock, JSON.stringify(copy))
    }
    const verified = await readOptionalNote(session, destinationPath, id)
    if (!verified || !sameNote(verified, copy)) {
      throw new Error('The moved note could not be verified. Its original has been preserved; reconnect to retry.')
    }
    // Expired locks fail closed. Keep both copies if the move took too long.
    await session.storage.refreshLock(destinationLock, MIGRATION_LOCK_SECONDS)
    await session.storage.refreshLock(sourceLock, MIGRATION_LOCK_SECONDS)
    await session.storage.deleteLocked(sourceLock)
  } catch (error) {
    if (hasStatus(error, 405)) {
      throw new Error('Your homeserver needs storage lock support to safely move existing notes. The original files are preserved.')
    }
    throw error
  } finally {
    for (const lock of locks.reverse()) {
      try { await session.storage.unlock(lock) } catch { /* Locks expire even if the network disconnects. */ }
      lock.free()
    }
  }
}

function sameNote(left: Note, right: Note): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function readFolder(session: Session, space: StorageSpace): Promise<Note[]> {
  const ids = await listIds(session, APP_PATHS[space])
  const results: Note[] = new Array(ids.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, ids.length) }, async () => {
    while (index < ids.length) {
      const position = index++
      const id = ids[position]
      const response = await session.storage.get(notePath(space, id))
      const note = validateNote(await readBoundedJson(response), id)
      results[position] = space === 'public' ? publicSnapshot(note) : note
    }
  }))
  return results
}

async function listIds(session: Session, folder: Path): Promise<string[]> {
  const owner = session.info.publicKey.z32()
  const ids = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  let entries = 0
  for (;;) {
    let batch: string[]
    try {
      batch = await session.storage.list(folder, cursor, false, LIST_PAGE_SIZE, true)
    } catch (error) {
      if (cursor === null && isMissing(error)) return []
      throw error
    }
    if (batch.length === 0) break
    entries += batch.length
    if (entries > MAX_NOTES) throw new Error(`This notebook exceeds the ${MAX_NOTES.toLocaleString()} note limit.`)
    for (const url of batch) {
      const resource = PubkyResource.parse(url)
      try {
        if (resource.owner.z32() !== owner || !resource.path.startsWith(folder)) {
          throw new Error('The homeserver returned a note outside this account’s Notes folder.')
        }
        const filename = resource.path.slice(folder.length)
        if (!filename.endsWith('.json') || filename.includes('/')) continue
        const id = filename.slice(0, -5)
        requireId(id)
        if (resource.path !== `${folder}${id}.json`) throw new Error('Invalid note path.')
        ids.add(id)
      } finally {
        resource.free()
      }
    }
    const nextCursor = batch[batch.length - 1]
    if (seenCursors.has(nextCursor)) throw new Error('The homeserver returned a repeated page of notes.')
    seenCursors.add(nextCursor)
    if (batch.length < LIST_PAGE_SIZE) break
    cursor = nextCursor
  }
  return [...ids]
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const error = new Error(`The note could not be loaded (HTTP ${response.status}).`)
    throw Object.assign(error, { data: { statusCode: response.status } })
  }
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_NOTE_BYTES) {
    await response.body?.cancel()
    throw new Error('This note is too large to open.')
  }
  if (!response.body) throw new Error('The homeserver returned an empty note response.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_NOTE_BYTES) {
        await reader.cancel()
        throw new Error('This note is too large to open.')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  try { return JSON.parse(text) } catch { throw new Error('The homeserver returned an invalid note file.') }
}

function validateNote(value: unknown, expectedId: string): Note {
  requireId(expectedId)
  if (typeof value !== 'object' || value === null) throw new Error('Invalid note data.')
  const record = value as Record<string, unknown>
  if (record.id !== expectedId || typeof record.title !== 'string' ||
      record.title.length > MAX_TITLE_LENGTH || typeof record.content !== 'string' ||
      record.content.length > MAX_CONTENT_LENGTH || !isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt)) {
    throw new Error('Invalid note data. The file must contain a valid title, Markdown, and timestamps.')
  }
  const note: Note = {
    id: expectedId,
    title: record.title,
    content: record.content,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  if (record.folder !== undefined) {
    if (typeof record.folder !== 'string') throw new Error('Invalid note folder.')
    const folder = normalizeFolder(record.folder)
    if (folder) note.folder = folder
  }
  if (new TextEncoder().encode(JSON.stringify(note)).byteLength > MAX_NOTE_BYTES) {
    throw new Error('This note is too large to save.')
  }
  return note
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
}

function requireId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid note ID.')
}

async function deleteIfPresent(session: Session, path: Path): Promise<void> {
  try { await session.storage.delete(path) } catch (error) { if (!isMissing(error)) throw error }
}

function isMissing(error: unknown): boolean {
  return hasStatus(error, 404) || hasStatus(error, 410)
}

function hasStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false
  const data = error.data
  return typeof data === 'object' && data !== null && 'statusCode' in data && data.statusCode === status
}
