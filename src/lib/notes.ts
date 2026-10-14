import { PubkyResource, PublicKey } from '@synonymdev/pubky'
import type { Address, Path, Session } from '@synonymdev/pubky'
import { APP_PATHS } from '../config'
import { getPubky } from './pubky'

export interface Note {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
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
  await session.storage.putJson(notePath('public', saved.id), saved)
  return saved
}

export async function unpublishNote(session: Session, id: string): Promise<void> {
  const privatePath = notePath('private', id)
  const publicPath = notePath('public', id)
  if (!await session.storage.exists(privatePath)) {
    let response: Response
    try {
      response = await session.storage.get(publicPath)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    // Preserve an orphaned snapshot if another app removed its private original.
    const snapshot = validateNote(await readBoundedJson(response), id)
    await saveNote(session, snapshot)
  }
  await deleteIfPresent(session, publicPath)
}

export async function deleteNote(session: Session, id: string): Promise<void> {
  // If public deletion fails, preserve the private original and report the failure.
  await deleteIfPresent(session, notePath('public', id))
  await deleteIfPresent(session, notePath('private', id))
}

export async function loadPublicNote(owner: string, id: string): Promise<Note> {
  requireId(id)
  const publicKey = PublicKey.from(owner)
  try {
    const address: Address = `pubky${publicKey.z32()}${APP_PATHS.public}${id}.json`
    const response = await getPubky().publicStorage.get(address)
    return validateNote(await readBoundedJson(response), id)
  } finally {
    publicKey.free()
  }
}

async function readFolder(session: Session, space: StorageSpace): Promise<Note[]> {
  const ids = await listIds(session, space)
  const results: Note[] = new Array(ids.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, ids.length) }, async () => {
    while (index < ids.length) {
      const position = index++
      const id = ids[position]
      const response = await session.storage.get(notePath(space, id))
      results[position] = validateNote(await readBoundedJson(response), id)
    }
  }))
  return results
}

async function listIds(session: Session, space: StorageSpace): Promise<string[]> {
  const folder = APP_PATHS[space]
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
        if (resource.path !== notePath(space, id)) throw new Error('Invalid note path.')
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
  if (!response.ok) throw new Error(`The note could not be loaded (HTTP ${response.status}).`)
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
  if (typeof error !== 'object' || error === null || !('data' in error)) return false
  const data = error.data
  return typeof data === 'object' && data !== null && 'statusCode' in data &&
    (data.statusCode === 404 || data.statusCode === 410)
}
