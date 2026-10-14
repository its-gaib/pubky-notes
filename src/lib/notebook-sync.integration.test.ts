import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { barrier, IntegrationHomeserver } from '../test/integration-homeserver'
import { editNote, initializeNote, noteRevision } from './crdt'
import {
  acknowledgeLocalNote, closeLocalNotebook, readLocalNotebook, writeLocalNote,
} from './local-notebook'
import { scopeForSession, synchronizeNotebook, uploadNotebook } from './notebook-sync'
import { deleteNote, listNotes, notePath, publishNote, saveNote } from './notes'
import type { Note, NoteRecord } from './notes'

// Intentionally no vi.mock: the CRDT, durable cache, sync, note serialization,
// validation, lock orchestration, and SDK address parser all execute together.
const row = (note: Note, published: Note | null = null): NoteRecord => ({ note, published })
const timestamp = '2026-10-14T12:00:00.000Z'
function note(content = 'First line\nSecond line', id = 'integration-note'): Note {
  return initializeNote({ id, title: 'A draft', content, createdAt: timestamp, updatedAt: timestamp })
}

beforeEach(async () => {
  await closeLocalNotebook()
  vi.stubGlobal('indexedDB', new IDBFactory())
})
afterEach(async () => { await closeLocalNotebook(); vi.unstubAllGlobals() })

describe('real cache, sync, and storage integration', () => {
  it('converges independent offline device edits through serialized homeserver files', async () => {
    const server = new IntegrationHomeserver()
    const first = server.session(), second = server.session()
    const scope = scopeForSession(first)
    const firstDatabase = new IDBFactory(), secondDatabase = new IDBFactory()
    const switchDevice = async (database: IDBFactory) => {
      await closeLocalNotebook()
      vi.stubGlobal('indexedDB', database)
    }
    const base = await saveNote(first, note())

    await switchDevice(firstDatabase)
    await synchronizeNotebook(first, scope)
    await writeLocalNote(scope, row(editNote(base, { content: 'Local first line\nSecond line' })))
    await switchDevice(secondDatabase)
    const secondInitial = await synchronizeNotebook(second, scope)
    expect(secondInitial.records[0].note.content).toBe(base.content)
    await writeLocalNote(scope, row(editNote(secondInitial.records[0].note, { content: 'First line\nRemote second line' })))
    await uploadNotebook(second, scope)

    await switchDevice(firstDatabase)
    const firstResult = await synchronizeNotebook(first, scope)
    expect(firstResult.records[0].note.content).toBe('Local first line\nRemote second line')
    expect(firstResult.pending).toEqual([])
    await switchDevice(secondDatabase)
    const secondResult = await synchronizeNotebook(second, scope)
    expect(secondResult.records).toEqual(firstResult.records)
    expect(secondResult.pending).toEqual([])
    const stored = (await listNotes(server.session()))[0].note
    expect(noteRevision(stored)).toBe(noteRevision(firstResult.records[0].note))
    expect(server.paths).toEqual([notePath('private', base.id)])
  })

  it('retains pending edits on real lock contention and merges them on retry', async () => {
    const server = new IntegrationHomeserver()
    const local = server.session(), remote = server.session(), scope = scopeForSession(local)
    const base = await saveNote(remote, note())
    await acknowledgeLocalNote(scope, row(base))
    await writeLocalNote(scope, row(editNote(base, { content: 'First line\nLocal second line' })))
    const hold = barrier()
    server.afterWrite = async ({ path }) => {
      if (path === notePath('private', base.id)) { server.afterWrite = undefined; await hold.wait() }
    }
    const remoteSave = saveNote(remote, editNote(base, { content: 'Remote first line\nSecond line' }))
    await hold.reached
    try {
      expect(server.activeLocks).toBe(2)
      await expect(uploadNotebook(local, scope)).rejects.toThrow('retained for retry')
      expect((await readLocalNotebook(scope)).pending).toEqual([base.id])
    } finally { hold.release() }
    await remoteSave
    await closeLocalNotebook()
    const retried = await uploadNotebook(local, scope)
    expect(retried.records[0].note.content).toBe('Remote first line\nLocal second line')
    expect(retried.pending).toEqual([])
    expect((await listNotes(remote))[0].note).toEqual(retried.records[0].note)
    expect(server.activeLocks).toBe(0)
  })

  it('recovers a committed write whose response was lost, after restart, without duplicate text', async () => {
    const server = new IntegrationHomeserver(), session = server.session(), scope = scopeForSession(session)
    const draft = editNote(note(), { content: 'First line\nSecond line\nExactly once' })
    await writeLocalNote(scope, row(draft))
    server.afterWrite = async () => {
      server.afterWrite = undefined
      throw new Error('Response lost after commit')
    }
    await expect(uploadNotebook(session, scope)).rejects.toThrow('Response lost after commit')
    expect(server.read<Note>(notePath('private', draft.id))?.content).toBe(draft.content)
    await closeLocalNotebook()
    expect((await readLocalNotebook(scope)).pending).toEqual([draft.id])
    const retried = await uploadNotebook(session, scope)
    const repeated = await synchronizeNotebook(session, scope)
    expect(retried.pending).toEqual([])
    expect(repeated.records).toHaveLength(1)
    expect(repeated.records[0].note.content).toBe(draft.content)
    expect(noteRevision(repeated.records[0].note)).toBe(noteRevision(draft))
    expect((await listNotes(server.session()))[0].note).toEqual(repeated.records[0].note)
    expect(server.activeLocks).toBe(0)
  })

  it('does not let a delayed verified acknowledgement clear text typed during an upload', async () => {
    const server = new IntegrationHomeserver(), session = server.session(), scope = scopeForSession(session)
    const draft = note()
    await writeLocalNote(scope, row(draft))
    const hold = barrier()
    server.afterWrite = async () => { server.afterWrite = undefined; await hold.wait() }
    const uploading = uploadNotebook(session, scope)
    await hold.reached
    const later = editNote(draft, { content: 'First line\nSecond line\nTyped while saving' })
    try { await writeLocalNote(scope, row(later)) } finally { hold.release() }
    const acknowledged = await uploading
    expect(acknowledged.records[0].note.content).toBe(later.content)
    expect(acknowledged.pending).toEqual([draft.id])
    expect(server.read<Note>(notePath('private', draft.id))?.content).toBe(draft.content)
    await closeLocalNotebook()
    const retried = await uploadNotebook(session, scope)
    expect(retried.pending).toEqual([])
    expect((await listNotes(server.session()))[0].note.content).toBe(later.content)
  })

  it('uploads incompatible histories separately and routes later stale-tab edits to the same private recovery', async () => {
    const server = new IntegrationHomeserver(), session = server.session(), scope = scopeForSession(session)
    const original = note('Original history'), replacement = note('Independent replacement')
    const oldPublic = { id: original.id, title: original.title, content: original.content, createdAt: timestamp, updatedAt: timestamp }
    await writeLocalNote(scope, row(original, oldPublic))
    server.seed(notePath('private', replacement.id), replacement)
    const currentPublic = await publishNote(server.session(), replacement)

    const recovered = await uploadNotebook(session, scope)
    expect(recovered.records).toHaveLength(2)
    expect(recovered.pending).toEqual([])
    const copy = recovered.records.find(record => record.note.id !== original.id)!
    expect(copy.note.content).toBe(original.content)
    expect(copy.note.title).toContain('(recovered)')
    expect(copy.published).toBeNull()
    await closeLocalNotebook()
    await writeLocalNote(scope, row(editNote(original, { content: 'Original history\nLater stale-tab edit' }), oldPublic))
    const retried = await uploadNotebook(session, scope)
    const again = await synchronizeNotebook(session, scope)

    expect(retried.pending).toEqual([])
    expect(again.records).toHaveLength(2)
    expect(again.records.find(record => record.note.id === copy.note.id)?.note.content).toBe('Original history\nLater stale-tab edit')
    expect(server.read<Note>(notePath('private', original.id))).toEqual(replacement)
    expect(server.read<Note>(notePath('public', original.id))).toEqual(currentPublic)
    expect(server.read(notePath('public', copy.note.id))).toBeUndefined()
    expect(server.paths).toHaveLength(3)
  })

  it('keeps concurrent offline edits in Trash, removes the public file, and restores only explicitly', async () => {
    const server = new IntegrationHomeserver(), session = server.session(), remote = server.session()
    const scope = scopeForSession(session), base = await saveNote(remote, note())
    await publishNote(remote, base)
    await synchronizeNotebook(session, scope)
    await writeLocalNote(scope, row(editNote(base, { content: 'First line\nOffline second line' })))
    await deleteNote(remote, editNote(base, { content: 'Remote first line\nSecond line' }))
    const merged = await uploadNotebook(session, scope)
    expect(merged.records[0].note.deleted).toBe(true)
    expect(merged.records[0].note.content).toBe('Remote first line\nOffline second line')
    expect(merged.pending).toEqual([])
    expect(server.read(notePath('public', base.id))).toBeUndefined()
    await closeLocalNotebook()
    const reloaded = await synchronizeNotebook(session, scope)
    expect(reloaded.records[0].note.deleted).toBe(true)

    await writeLocalNote(scope, row(editNote(reloaded.records[0].note, { deleted: false })))
    const restored = await uploadNotebook(session, scope)
    expect(restored.records[0].note.deleted).not.toBe(true)
    expect(restored.records[0].note.content).toBe('Remote first line\nOffline second line')
    expect(restored.pending).toEqual([])
    expect((await listNotes(remote))[0].note).toEqual(restored.records[0].note)
    expect(server.paths).toEqual([notePath('private', base.id)])
  })

  it('publishes exactly the reviewed snapshot while merged text, folders, and deleted text history stay private', async () => {
    const server = new IntegrationHomeserver(), session = server.session(), remote = server.session()
    const scope = scopeForSession(session)
    const secret = 'DELETED PRIVATE SECRET', unseen = 'UNREVIEWED REMOTE SECRET'
    const original = note(`First line\n${secret}`)
    const base = await saveNote(session, editNote(original, { content: 'First line\nPublic ending', folder: 'Private projects/Secret' }))
    await synchronizeNotebook(session, scope)
    const reviewed = editNote(base, { content: 'Reviewed first line\nPublic ending' })
    await writeLocalNote(scope, row(reviewed))
    await saveNote(remote, editNote(base, { content: `First line\nPublic ending\n${unseen}` }))

    const published = await publishNote(session, reviewed)
    const synced = await synchronizeNotebook(session, scope)
    expect(synced.records[0].note.content).toBe(`Reviewed first line\nPublic ending\n${unseen}`)
    expect(synced.pending).toEqual([])
    const publicFile = server.read<Note>(notePath('public', base.id))!
    expect(publicFile).toEqual(published)
    expect(publicFile.content).toBe(reviewed.content)
    expect(Object.keys(publicFile).sort()).toEqual(['content', 'createdAt', 'id', 'title', 'updatedAt'])
    expect(JSON.stringify(publicFile)).not.toContain(secret)
    expect(JSON.stringify(publicFile)).not.toContain(unseen)
    expect(JSON.stringify(publicFile)).not.toContain('Private projects')
    expect(server.read<Note>(notePath('private', base.id))?.crdt).toBeDefined()

    await writeLocalNote(scope, row(editNote(synced.records[0].note, { content: `${synced.records[0].note.content}\nLater private edit` }), published))
    await uploadNotebook(session, scope)
    expect(server.read(notePath('public', base.id))).toEqual(publicFile)
    expect((await listNotes(remote))[0].note.content).toContain('Later private edit')
  })
})
