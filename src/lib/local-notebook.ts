import { editNote, ensureCrdt, initializeNote, mergeNotes, noteRevision } from './crdt'
import type { CrdtNote } from './crdt'
import { normalizeFolderPaths } from './folder-store'
import type { NoteRecord } from './notes'

const DATABASE_NAME = 'pubky-notes:local:v1'
const MAX_NOTES = 2_000
const STORES = ['notes', 'metadata', 'claims', 'recoveries']

interface StoredNote {
  scope: string
  id: string
  record: NoteRecord
  pending: boolean
}

interface NotebookMetadata {
  scope: string
  folders: string[]
  foldersPending: boolean
  activeId: string
}

interface GuestClaim {
  scope: string
  id: string
  targetScope: string
  targetId: string
}

export interface LocalNoteRecovery {
  id: string
  createdAt: string
  lineage: string
  targetId: string
}

interface StoredRecovery extends LocalNoteRecovery {
  scope: string
}

export interface LocalNotebook {
  records: NoteRecord[]
  pending: string[]
  folders: string[]
  foldersPending: boolean
  activeId: string
  recoveries?: LocalNoteRecovery[]
}

export interface AdoptedNotebook extends LocalNotebook {
  idMap: Record<string, string>
}

let database: Promise<IDBDatabase> | undefined

/** All scopes are explicit: an asynchronous save must retain its originating account. */
export async function readLocalNotebook(scope: string): Promise<LocalNotebook> {
  requireScope(scope)
  return transact('readonly', async (transaction) => readNotebook(transaction, scope))
}

/** Resolve this exact local history without routing a remote acknowledgement. */
export async function resolveLocalNoteDestination(scope: string, note: CrdtNote): Promise<{ scope: string; id: string }> {
  requireScope(scope)
  const prepared = await ensureCrdt(note)
  return transact('readonly', (transaction) => resolveLocalDestination(transaction, scope, prepared))
}

/** Commit the edit and its outbox entry together before reporting a local save. */
export async function writeLocalNote(scope: string, record: NoteRecord): Promise<NoteRecord> {
  requireScope(scope)
  const prepared = { ...record, note: await ensureCrdt(record.note) }
  return transact('readwrite', async (transaction) => {
    const destination = await resolveLocalDestination(transaction, scope, prepared.note)
    const incoming = remapRecord(prepared, destination.id)
    // A copy made to preserve an incompatible history starts private, including
    // writes from a stale tab that still remembers the original publication.
    if (destination.id !== prepared.note.id) incoming.published = null
    const store = transaction.objectStore('notes')
    const existing = await request<StoredNote | undefined>(store.get([destination.scope, destination.id]))
    const merged: NoteRecord = existing
      ? { note: mergeNotes(existing.record.note, incoming.note), published: incoming.published }
      : incoming
    if (!existing) await checkCapacity(transaction, destination.scope)
    store.put({ scope: destination.scope, id: destination.id, record: merged, pending: true } satisfies StoredNote)
    return merged
  })
}

/** A late server acknowledgement must never clear edits made while it was in flight. */
export async function acknowledgeLocalNote(
  scope: string,
  serverRecord: NoteRecord,
): Promise<{ record: NoteRecord; pending: boolean; recovered?: NoteRecord }> {
  requireScope(scope)
  const prepared = { ...serverRecord, note: await ensureCrdt(serverRecord.note) }
  return transact('readwrite', async (transaction) => {
    const destination = await resolveDestination(transaction, scope, prepared.note.id)
    const incoming = remapRecord(prepared, destination.id)
    const store = transaction.objectStore('notes')
    const existing = await request<StoredNote | undefined>(store.get([destination.scope, destination.id]))
    if (existing && !sameHistory(existing.record, incoming)) {
      await checkCapacity(transaction, destination.scope)
      const recovered: NoteRecord = {
        note: editNote({ ...existing.record.note, id: crypto.randomUUID() }, {
          title: `${existing.record.note.title.slice(0, 188)} (recovered)`,
        }),
        published: null,
      }
      store.put({ scope: destination.scope, id: recovered.note.id, record: recovered, pending: true } satisfies StoredNote)
      store.put({ scope: destination.scope, id: destination.id, record: incoming, pending: false } satisfies StoredNote)
      transaction.objectStore('recoveries').put({
        scope: destination.scope,
        id: destination.id,
        createdAt: existing.record.note.createdAt,
        lineage: existing.record.note.crdt!.lineage,
        targetId: recovered.note.id,
      } satisfies StoredRecovery)
      // Guest tabs holding the recovered history must follow it to its new ID.
      const claims = transaction.objectStore('claims')
      const relatedClaims = await request<GuestClaim[]>(claims.index('destination').getAll([destination.scope, destination.id]))
      for (const claim of relatedClaims) claims.put({ ...claim, targetId: recovered.note.id })
      const metadata = await readMetadata(transaction, destination.scope)
      if (metadata.activeId === destination.id) transaction.objectStore('metadata').put({ ...metadata, activeId: recovered.note.id })
      return { record: incoming, pending: false, recovered }
    }
    const record: NoteRecord = existing
      ? { note: mergeNotes(existing.record.note, incoming.note), published: incoming.published }
      : incoming
    const pending = noteRevision(record.note) !== noteRevision(incoming.note)
    if (!existing) await checkCapacity(transaction, destination.scope)
    store.put({ scope: destination.scope, id: destination.id, record, pending } satisfies StoredNote)
    return { record, pending }
  })
}

export const cacheRemoteNote = acknowledgeLocalNote

export async function acceptRemoteFolders(scope: string, folders: string[]): Promise<void> {
  await writeLocalFolders(scope, folders, false)
}

export async function writeLocalFolders(scope: string, folders: string[], dirty = true): Promise<void> {
  requireScope(scope)
  const normalized = normalizeFolderPaths(folders)
  await transact('readwrite', async (transaction) => {
    const metadata = await readMetadata(transaction, scope)
    // A background remote refresh cannot replace a locally edited folder registry.
    if (!dirty && metadata.foldersPending) return
    transaction.objectStore('metadata').put({ ...metadata, folders: normalized, foldersPending: dirty })
  })
}

export async function acknowledgeLocalFolders(scope: string, sentFolders: string[]): Promise<void> {
  requireScope(scope)
  const normalized = normalizeFolderPaths(sentFolders)
  await transact('readwrite', async (transaction) => {
    const metadata = await readMetadata(transaction, scope)
    if (JSON.stringify(metadata.folders) !== JSON.stringify(normalized)) return
    transaction.objectStore('metadata').put({ ...metadata, foldersPending: false })
  })
}

export async function setLocalActiveId(scope: string, id: string): Promise<void> {
  requireScope(scope)
  if (id) requireId(id)
  await transact('readwrite', async (transaction) => {
    const destination = id ? await resolveDestination(transaction, scope, id) : { scope, id }
    const metadata = await readMetadata(transaction, destination.scope)
    transaction.objectStore('metadata').put({ ...metadata, activeId: destination.id })
  })
}

/**
 * Move guest drafts into one account atomically. Persistent claims also route later
 * writes from an already-open guest tab to that same account, never the next login.
 */
export async function adoptGuestNotebook(guestScope: string, targetScope: string): Promise<AdoptedNotebook> {
  requireScope(guestScope)
  requireScope(targetScope)
  if (!guestScope.endsWith(':guest') || targetScope.endsWith(':guest') ||
      guestScope.split(':')[0] !== targetScope.split(':')[0]) {
    throw new Error('Guest notes can only be adopted into an account on the same network.')
  }
  return transact('readwrite', async (transaction) => {
    const notes = transaction.objectStore('notes')
    const claims = transaction.objectStore('claims')
    const [guestNotes, guestMetadata, targetMetadata, previousClaims] = await Promise.all([
      readStoredNotes(transaction, guestScope),
      readMetadata(transaction, guestScope),
      readMetadata(transaction, targetScope),
      request<GuestClaim[]>(claims.index('scope').getAll(guestScope)),
    ])
    const idMap: Record<string, string> = Object.create(null)
    for (const claim of previousClaims) {
      if (claim.targetScope === targetScope) idMap[claim.id] = claim.targetId
    }
    let adopted = false
    for (const guest of guestNotes) {
      const claim = await request<GuestClaim | undefined>(claims.get([guestScope, guest.id]))
      // A stale guest record can never be imported into a second account.
      const destination = claim
        ? { scope: claim.targetScope, id: claim.targetId }
        : { scope: targetScope, id: guest.id }
      let incoming = remapRecord(guest.record, destination.id)
      let existing = await request<StoredNote | undefined>(notes.get([destination.scope, destination.id]))
      if (existing && !sameHistory(existing.record, incoming)) {
        // Preserve the guest history so later edits in the originating tab can merge.
        // Independent documents that happened to share an ID must remain separate.
        if (claim) throw new Error('A claimed guest note has a different editing history. Both copies have been retained.')
        destination.id = crypto.randomUUID()
        incoming = remapRecord(guest.record, destination.id)
        existing = undefined
      }
      if (!existing) await checkCapacity(transaction, destination.scope)
      const record: NoteRecord = existing
        ? { note: mergeNotes(existing.record.note, incoming.note), published: existing.record.published }
        : { note: initializeNote(incoming.note), published: null }
      notes.put({ scope: destination.scope, id: destination.id, record, pending: true } satisfies StoredNote)
      claims.put({ scope: guestScope, id: guest.id, targetScope: destination.scope, targetId: destination.id } satisfies GuestClaim)
      notes.delete([guestScope, guest.id])
      if (destination.scope === targetScope) {
        idMap[guest.id] = destination.id
        adopted = true
      }
    }
    const folders = normalizeFolderPaths([...targetMetadata.folders, ...guestMetadata.folders])
    const activeId = idMap[guestMetadata.activeId] ?? targetMetadata.activeId
    transaction.objectStore('metadata').put({
      ...targetMetadata,
      folders,
      foldersPending: targetMetadata.foldersPending || guestMetadata.foldersPending ||
        (adopted && JSON.stringify(folders) !== JSON.stringify(targetMetadata.folders)),
      activeId,
    } satisfies NotebookMetadata)
    transaction.objectStore('metadata').put(emptyMetadata(guestScope))
    return { ...await readNotebook(transaction, targetScope), idMap }
  })
}

/** Close connections on version changes and in tests; this never removes notebook data. */
export async function closeLocalNotebook(): Promise<void> {
  const connection = database
  database = undefined
  if (connection) (await connection).close()
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database
  database = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('Local note storage is unavailable in this browser.'))
      return
    }
    const opening = indexedDB.open(DATABASE_NAME, 2)
    opening.onupgradeneeded = () => {
      const db = opening.result
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: ['scope', 'id'] }).createIndex('scope', 'scope')
        db.createObjectStore('metadata', { keyPath: 'scope' })
        const claims = db.createObjectStore('claims', { keyPath: ['scope', 'id'] })
        claims.createIndex('scope', 'scope')
        claims.createIndex('destination', ['targetScope', 'targetId'])
      }
      if (!db.objectStoreNames.contains('recoveries')) {
        db.createObjectStore('recoveries', { keyPath: ['scope', 'id', 'createdAt', 'lineage'] }).createIndex('scope', 'scope')
      }
    }
    opening.onsuccess = () => {
      const db = opening.result
      db.onversionchange = () => { db.close(); database = undefined }
      resolve(db)
    }
    opening.onerror = () => reject(opening.error ?? new Error('Local note storage could not be opened.'))
    opening.onblocked = () => reject(new Error('Close other Pubky Notes tabs to upgrade local note storage.'))
  }).catch((error: unknown) => { database = undefined; throw error })
  return database
}

async function transact<T>(mode: IDBTransactionMode, operation: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openDatabase()
  // Strict durability asks the browser to flush committed edits before completion.
  const transaction = db.transaction(STORES, mode, { durability: mode === 'readwrite' ? 'strict' : 'default' })
  const complete = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Local note storage did not commit.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('Local note storage failed.'))
  })
  // Install a rejection handler immediately, including when an IDB request rejects first.
  void complete.catch(() => undefined)
  try {
    const result = await operation(transaction)
    await complete
    return result
  } catch (error) {
    try { transaction.abort() } catch { /* Already completed or aborted. */ }
    await complete.catch(() => undefined)
    throw error
  }
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () => reject(operation.error ?? new Error('Local note storage failed.'))
  })
}

async function resolveDestination(transaction: IDBTransaction, scope: string, id: string): Promise<{ scope: string; id: string }> {
  if (!scope.endsWith(':guest')) return { scope, id }
  const claim = await request<GuestClaim | undefined>(transaction.objectStore('claims').get([scope, id]))
  return claim ? { scope: claim.targetScope, id: claim.targetId } : { scope, id }
}

async function resolveLocalDestination(transaction: IDBTransaction, scope: string, note: CrdtNote): Promise<{ scope: string; id: string }> {
  const destination = await resolveDestination(transaction, scope, note.id)
  return {
    scope: destination.scope,
    id: await resolveRecoveryId(transaction, destination.scope, destination.id, note.createdAt, note.crdt!.lineage),
  }
}

async function resolveRecoveryId(transaction: IDBTransaction, scope: string, id: string, createdAt: string, lineage: string): Promise<string> {
  const seen = new Set<string>()
  const recoveries = transaction.objectStore('recoveries')
  while (!seen.has(id)) {
    seen.add(id)
    const recovery = await request<StoredRecovery | undefined>(recoveries.get([scope, id, createdAt, lineage]))
    if (!recovery) return id
    id = recovery.targetId
  }
  throw new Error('The local note recovery destination contains a cycle.')
}

async function readStoredNotes(transaction: IDBTransaction, scope: string): Promise<StoredNote[]> {
  const records = await request<StoredNote[]>(transaction.objectStore('notes').index('scope').getAll(scope, MAX_NOTES + 1))
  if (records.length > MAX_NOTES) throw new Error(`This local notebook exceeds the ${MAX_NOTES.toLocaleString()} note limit.`)
  return records
}

async function readMetadata(transaction: IDBTransaction, scope: string): Promise<NotebookMetadata> {
  return await request<NotebookMetadata | undefined>(transaction.objectStore('metadata').get(scope)) ?? emptyMetadata(scope)
}

async function readNotebook(transaction: IDBTransaction, scope: string): Promise<LocalNotebook> {
  const [stored, metadata, redirects] = await Promise.all([
    readStoredNotes(transaction, scope), readMetadata(transaction, scope),
    request<StoredRecovery[]>(transaction.objectStore('recoveries').index('scope').getAll(scope)),
  ])
  const recoveries = await Promise.all(redirects.map(async ({ id, createdAt, lineage }) => ({
    id, createdAt, lineage, targetId: await resolveRecoveryId(transaction, scope, id, createdAt, lineage),
  })))
  stored.sort((left, right) => right.record.note.updatedAt.localeCompare(left.record.note.updatedAt))
  return { records: stored.map(({ record }) => record), pending: stored.filter(({ pending }) => pending).map(({ id }) => id),
    folders: metadata.folders, foldersPending: metadata.foldersPending, activeId: metadata.activeId,
    ...(recoveries.length ? { recoveries } : {}) }
}

async function checkCapacity(transaction: IDBTransaction, scope: string): Promise<void> {
  if (await request(transaction.objectStore('notes').index('scope').count(scope)) >= MAX_NOTES) {
    throw new Error(`This local notebook can contain at most ${MAX_NOTES.toLocaleString()} notes.`)
  }
}

function emptyMetadata(scope: string): NotebookMetadata {
  return { scope, folders: [], foldersPending: false, activeId: '' }
}

function remapRecord(record: NoteRecord, id: string): NoteRecord {
  return { note: { ...record.note, id }, published: record.published ? { ...record.published, id } : null }
}

function sameHistory(left: NoteRecord, right: NoteRecord): boolean {
  try { mergeNotes(left.note, right.note); return true } catch (error) {
    if (error instanceof Error && error.name === 'LineageConflictError') return false
    throw error
  }
}

function requireScope(scope: string): void {
  if (typeof scope !== 'string' || !/^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9_-]{1,128}$/.test(scope)) {
    throw new Error('Invalid local notebook account scope.')
  }
}

function requireId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid note ID.')
}
