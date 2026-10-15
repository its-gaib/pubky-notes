import { PubkyResource, PublicKey } from '@synonymdev/pubky'
import type { Address, Path, Session, StorageLock } from '@synonymdev/pubky'
import { APP_PATHS } from '../config'
import { getPubky } from './pubky'
import { editNote, ensureCrdt, initializeNote, MAX_CONTENT_LENGTH, MAX_NOTE_BYTES, mergeNotes, noteRevision, prepareLocalNote, validateCrdtNote } from './crdt'
import type { CrdtNote } from './crdt'

export interface Note extends CrdtNote {}

export interface NoteRecord {
  note: Note
  published: Note | null
}

export { MAX_NOTE_BYTES, MAX_CONTENT_LENGTH }
const LIST_PAGE_SIZE = 100
const MAX_NOTES = 2_000
const DOWNLOAD_CONCURRENCY = 5
const LOCK_SECONDS = 60
type StorageSpace = keyof typeof APP_PATHS
type Locks = Record<StorageSpace, StorageLock>

export function createNote(text: Partial<Pick<Note, 'title' | 'content' | 'folder'>> = {}): Note {
  const now = new Date().toISOString()
  return initializeNote({ id: crypto.randomUUID(), title: 'Untitled note', content: '', ...text, createdAt: now, updatedAt: now })
}

export function notePath(space: StorageSpace, id: string): Path {
  requireId(id)
  return `${APP_PATHS[space]}${id}.json`
}

export async function listNotes(session: Session): Promise<NoteRecord[]> {
  const [privateNotes, publicNotes] = await Promise.all([
    readFolder(session, 'private'),
    readFolder(session, 'public'),
  ])
  const published = new Map(publicNotes.map((note) => [note.id, note]))
  const canonical = new Map(privateNotes.map((note) => [note.id, note]))
  // Keep public files discoverable even if another app removed their private original.
  for (const note of publicNotes) if (!canonical.has(note.id)) canonical.set(note.id, await ensureCrdt(note))
  return [...canonical.values()]
    .map((note) => ({ note, published: published.get(note.id) ?? null }))
    .sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt))
}

export async function saveNote(session: Session, note: Note): Promise<Note> {
  requireId(note.id)
  const local = await prepareLocalNote(note)
  return withLocks(session, local.id, async locks => {
    const merged = await mergeStored(session, local)
    return writeVerified(session, locks, merged)
  })
}

export async function publishNote(session: Session, note: Note): Promise<Note> {
  requireId(note.id)
  const reviewed = await prepareLocalNote(note)
  if (reviewed.deleted) throw new Error('Restore this note before publishing it.')
  return withLocks(session, note.id, async locks => {
    const merged = await mergeStored(session, reviewed)
    if (merged.deleted) throw new Error('This note was moved to Trash. Restore it before publishing.')
    await writeVerified(session, locks, merged)
    // Only the text the user reviewed is published, even if private saving merged remote edits.
    const snapshot = publicSnapshot(reviewed)
    await renew(session, locks)
    await session.storage.putTextLocked(locks.public, JSON.stringify(snapshot))
    const confirmed = await readOptionalNote(session, notePath('public', note.id), note.id, false)
    if (!confirmed || JSON.stringify(confirmed) !== JSON.stringify(snapshot)) throw new Error('The published snapshot could not be verified. Your private note is retained.')
    return snapshot
  })
}

export async function unpublishNote(session: Session, id: string): Promise<void> {
  await withLocks(session, id, async locks => {
    if (!await readOptionalNote(session, notePath('private', id), id)) {
      const original = await readOptionalNote(session, notePath('public', id), id, false)
      if (original) await writeVerified(session, locks, await ensureCrdt(original))
    }
    await renew(session, locks)
    await deleteLockedIfPresent(session, locks.public)
  })
}

export async function deleteNote(session: Session, input: Note | string): Promise<Note> {
  const id = typeof input === 'string' ? input : input.id
  const local = typeof input === 'string' ? null : await prepareLocalNote(input)
  return withLocks(session, id, async locks => {
    const original = local ? await mergeStored(session, local) :
      await readOptionalNote(session, notePath('private', id), id) ??
      await readOptionalNote(session, notePath('public', id), id, false)
    if (!original) throw new Error('This note could not be found. Your local copy is retained.')
    const tombstone = editNote(await ensureCrdt(original), { deleted: true })
    // Keep the original untouched if removing its public snapshot fails.
    await renew(session, locks)
    await deleteLockedIfPresent(session, locks.public)
    return writeVerified(session, locks, tombstone)
  })
}

export async function loadPublicNote(owner: string, id: string): Promise<Note> {
  requireId(id)
  const publicKey = PublicKey.from(owner)
  try {
    const address: Address = `pubky${publicKey.z32()}${APP_PATHS.public}${id}.json`
    const response = await getPubky().publicStorage.get(address)
    return validateNote(await readBoundedJson(response), id, false)
  } finally {
    publicKey.free()
  }
}

export function publicSnapshot(note: Note): Note {
  return { id: note.id, title: note.title, content: note.content, createdAt: note.createdAt, updatedAt: note.updatedAt }
}

async function readOptionalNote(session: Session, path: Path, id: string, privateNote = true): Promise<Note | null> {
  try { return await validateNote(await readBoundedJson(await session.storage.get(path)), id, privateNote) } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
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
      results[position] = await validateNote(await readBoundedJson(response), id, space === 'private')
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

async function validateNote(value: unknown, expectedId: string, privateNote = true): Promise<Note> {
  requireId(expectedId)
  if (typeof value !== 'object' || value === null) throw new Error('Invalid note data.')
  const record = value as Record<string, unknown>
  if (record.id !== expectedId) throw new Error('Invalid note data. The note ID must match its filename.')
  const note = validateCrdtNote(privateNote ? value as Note : publicSnapshot(value as Note))
  return privateNote ? ensureCrdt(note) : note
}

function requireId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid note ID.')
}

async function mergeStored(session: Session, local: Note): Promise<Note> {
  const existing = await readOptionalNote(session, notePath('private', local.id), local.id) ??
    await readOptionalNote(session, notePath('public', local.id), local.id, false)
  return existing ? mergeNotes(local, await ensureCrdt(existing)) : local
}

async function writeVerified(session: Session, locks: Locks, note: Note): Promise<Note> {
  await renew(session, locks)
  await session.storage.putTextLocked(locks.private, JSON.stringify(note))
  const confirmed = await readOptionalNote(session, notePath('private', note.id), note.id)
  if (!confirmed || noteRevision(mergeNotes(confirmed, note)) !== noteRevision(confirmed)) {
    throw new Error('The homeserver save could not be verified. Your local changes are retained for retry.')
  }
  return confirmed
}

async function withLocks<T>(session: Session, id: string, action: (locks: Locks) => Promise<T>): Promise<T> {
  requireId(id)
  const acquired: StorageLock[] = []
  const locks = {} as Locks
  try {
    for (const space of ['private', 'public'] as const) {
      const lock = await session.storage.lock(notePath(space, id), LOCK_SECONDS)
      acquired.push(lock)
      locks[space] = lock
    }
    await renew(session, locks)
    return await action(locks)
  } catch (error) {
    if (hasStatus(error, 405)) throw new Error('This homeserver does not support safe note locking. Changes remain on this device.')
    if (hasStatus(error, 412) || hasStatus(error, 423)) throw new Error('This note is being changed or its lock expired. Your local changes are retained for retry.')
    throw error
  } finally {
    for (const lock of acquired.reverse()) {
      try { await session.storage.unlock(lock) } catch { /* Locks expire if the connection is lost. */ }
      lock.free()
    }
  }
}

async function renew(session: Session, locks: Locks): Promise<void> {
  await session.storage.refreshLock(locks.private, LOCK_SECONDS)
  await session.storage.refreshLock(locks.public, LOCK_SECONDS)
}

async function deleteLockedIfPresent(session: Session, lock: StorageLock): Promise<void> {
  try { await session.storage.deleteLocked(lock) } catch (error) { if (!isMissing(error)) throw error }
}

function isMissing(error: unknown): boolean {
  return hasStatus(error, 404) || hasStatus(error, 410)
}

function hasStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false
  const data = error.data
  return typeof data === 'object' && data !== null && 'statusCode' in data && data.statusCode === status
}
