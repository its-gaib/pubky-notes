import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editNote, initializeNote, noteRevision } from './crdt'
import type { CrdtNote } from './crdt'
import type { NoteRecord } from './notes'
import {
  acceptRemoteFolders, acknowledgeLocalFolders, acknowledgeLocalNote, adoptGuestNotebook,
  closeLocalNotebook, readLocalNotebook, resolveLocalNoteDestination, setLocalActiveId, writeLocalFolders, writeLocalNote,
} from './local-notebook'

const guest = 'mainnet:guest'
const alice = 'mainnet:alice'
const bob = 'mainnet:bob'

function note(id = 'one', content = 'First line\nSecond line'): CrdtNote {
  return initializeNote({ id, title: 'A note', content, createdAt: '2026-10-14T12:00:00Z', updatedAt: '2026-10-14T12:00:00Z' })
}

function record(note: CrdtNote): NoteRecord { return { note, published: null } }

beforeEach(async () => {
  await closeLocalNotebook()
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(async () => {
  vi.restoreAllMocks()
  await closeLocalNotebook()
  vi.unstubAllGlobals()
})

describe('durable account-scoped local notebook', () => {
  it('restores committed drafts, the outbox, folders, and selection after reconnecting to IndexedDB', async () => {
    const draft = note()
    await writeLocalNote(guest, record(draft))
    await writeLocalFolders(guest, ['Work/Ideas', 'Empty'])
    await setLocalActiveId(guest, draft.id)
    await closeLocalNotebook()
    expect(await readLocalNotebook(guest)).toEqual({
      records: [record(draft)], pending: [draft.id], folders: ['Empty', 'Work/Ideas'], foldersPending: true, activeId: draft.id,
    })
    expect((await readLocalNotebook(alice)).records).toEqual([])
  })

  it('merges edits from two tabs without losing independent changes', async () => {
    const base = note()
    await acknowledgeLocalNote(alice, record(base))
    const first = editNote(base, { content: 'First line changed\nSecond line' })
    const second = editNote(base, { content: 'First line\nSecond line changed' })
    await Promise.all([writeLocalNote(alice, record(first)), writeLocalNote(alice, record(second))])
    const stored = await readLocalNotebook(alice)
    expect(stored.records[0].note.content).toBe('First line changed\nSecond line changed')
    expect(stored.pending).toEqual([base.id])
  })

  it('keeps newer local edits pending when an earlier upload finishes', async () => {
    const base = note()
    const first = editNote(base, { content: 'First edit' })
    const second = editNote(first, { content: 'First edit then another edit' })
    await writeLocalNote(alice, record(first))
    await writeLocalNote(alice, record(second))
    const staleAck = await acknowledgeLocalNote(alice, record(first))
    expect(staleAck.pending).toBe(true)
    expect(staleAck.record.note.content).toBe(second.content)
    expect((await readLocalNotebook(alice)).pending).toEqual([base.id])
    const latestAck = await acknowledgeLocalNote(alice, staleAck.record)
    expect(latestAck.pending).toBe(false)
    expect((await readLocalNotebook(alice)).pending).toEqual([])
  })

  it('accepts public snapshots only from the incoming record while merging private edits', async () => {
    const base = note()
    const changed = editNote(base, { content: 'New private text' })
    await writeLocalNote(alice, record(changed))
    const acknowledged = await acknowledgeLocalNote(alice, { note: base, published: base })
    expect(acknowledged.record.note.content).toBe(changed.content)
    expect(acknowledged.record.published?.content).toBe(base.content)
    expect(acknowledged.pending).toBe(true)
  })

  it('adopts guest drafts once, preserves the selected note, and keeps later guest-tab writes in that account', async () => {
    const draft = note()
    await writeLocalNote(guest, record(draft))
    await writeLocalFolders(guest, ['Drafts'])
    await setLocalActiveId(guest, draft.id)
    const adopted = await adoptGuestNotebook(guest, alice)
    expect(adopted.records).toEqual([record(draft)])
    expect(adopted.pending).toEqual([draft.id])
    expect(adopted.folders).toEqual(['Drafts'])
    expect(adopted.activeId).toBe(draft.id)
    expect(adopted.idMap).toEqual({ [draft.id]: draft.id })
    expect((await readLocalNotebook(guest)).records).toEqual([])
    const afterLogin = editNote(draft, { content: 'Still writing in the old guest tab' })
    await writeLocalNote(guest, record(afterLogin))
    await setLocalActiveId(guest, draft.id)
    expect((await readLocalNotebook(guest)).records).toEqual([])
    expect((await readLocalNotebook(alice)).records[0].note.content).toBe(afterLogin.content)
    expect((await adoptGuestNotebook(guest, bob)).records).toEqual([])
    expect((await readLocalNotebook(bob)).folders).toEqual([])
  })

  it('can adopt a new guest note into a different account without moving previously claimed notes', async () => {
    const first = note('first'), second = note('second')
    await writeLocalNote(guest, record(first))
    await adoptGuestNotebook(guest, alice)
    await writeLocalNote(guest, record(second))
    await adoptGuestNotebook(guest, bob)
    await Promise.all([
      writeLocalNote(guest, record(editNote(first, { content: 'Alice draft edit' }))),
      writeLocalNote(guest, record(editNote(second, { content: 'Bob draft edit' }))),
    ])
    expect((await readLocalNotebook(alice)).records.map(({ note }) => note.content)).toEqual(['Alice draft edit'])
    expect((await readLocalNotebook(bob)).records.map(({ note }) => note.content)).toEqual(['Bob draft edit'])
  })

  it('merges a duplicate guest ID with the same history idempotently', async () => {
    const base = note()
    await acknowledgeLocalNote(alice, record(editNote(base, { content: 'Remote first\nSecond line' })))
    await writeLocalNote(guest, record(editNote(base, { content: 'First line\nGuest second' })))
    const adopted = await adoptGuestNotebook(guest, alice)
    expect(adopted.records).toHaveLength(1)
    expect(adopted.records[0].note.content).toBe('Remote first\nGuest second')
    const retried = await adoptGuestNotebook(guest, alice)
    expect(retried.records).toEqual(adopted.records)
    expect(retried.idMap[base.id]).toBe(base.id)
  })

  it('preserves both histories on an ID collision and redirects subsequent guest edits to the recovery copy', async () => {
    const remote = note('same', 'Account text'), draft = note('same', 'Guest text')
    await acknowledgeLocalNote(alice, record(remote))
    await writeLocalNote(guest, record(draft))
    await setLocalActiveId(guest, draft.id)
    const adopted = await adoptGuestNotebook(guest, alice)
    const destination = adopted.idMap[draft.id]
    expect(destination).not.toBe(draft.id)
    expect(adopted.activeId).toBe(destination)
    expect(adopted.records.map(({ note }) => note.content).sort()).toEqual(['Account text', 'Guest text'])
    await writeLocalNote(guest, record(editNote(draft, { content: 'Guest text extended' })))
    expect((await readLocalNotebook(alice)).records.find(({ note }) => note.id === destination)?.note.content).toBe('Guest text extended')
    expect((await adoptGuestNotebook(guest, bob)).records).toEqual([])
  })

  it('atomically preserves a local recovery copy before accepting an unrelated remote editing history', async () => {
    const original = note('one', 'Local unsaved text'), remote = note('one', 'Different remote text')
    await writeLocalNote(guest, record(original))
    await setLocalActiveId(guest, original.id)
    await adoptGuestNotebook(guest, alice)
    const result = await acknowledgeLocalNote(alice, record(remote))
    expect(result.record.note.content).toBe(remote.content)
    expect(result.pending).toBe(false)
    expect(result.recovered?.note.content).toBe(original.content)
    expect(result.recovered?.note.title).toBe('A note (recovered)')
    const stored = await readLocalNotebook(alice)
    expect(stored.records).toHaveLength(2)
    expect(stored.pending).toEqual([result.recovered!.note.id])
    expect(stored.activeId).toBe(result.recovered!.note.id)
    await writeLocalNote(guest, record(editNote(original, { content: 'Local unsaved text continued' })))
    const latest = await readLocalNotebook(alice)
    expect(latest.records.find(({ note }) => note.id === result.recovered!.note.id)?.note.content).toBe('Local unsaved text continued')
  })

  it('retains both persisted drafts when a write from an unrelated history is rejected', async () => {
    const original = note('same', 'Original text')
    await writeLocalNote(alice, record(original))
    await expect(writeLocalNote(alice, record(note('same', 'Unrelated text')))).rejects.toThrow('different editing histories')
    expect(noteRevision((await readLocalNotebook(alice)).records[0].note)).toBe(noteRevision(original))
  })

  it('persists repeated stale signed-in edits into the same private recovery after reopening storage', async () => {
    const original = note('same', 'Original local text'), remote = note('same', 'Authoritative remote text')
    await writeLocalNote(alice, { note: original, published: original })
    const recovered = (await acknowledgeLocalNote(alice, record(remote))).recovered!
    await closeLocalNotebook()
    const first = editNote(original, { content: 'Original local text continued' })
    const saved = await writeLocalNote(alice, { note: first, published: original })
    expect(saved.note.id).toBe(recovered.note.id)
    expect(saved.note.content).toBe(first.content)
    expect(saved.published).toBeNull()
    const second = editNote(first, { content: 'Original local text continued again' })
    const savedAgain = await writeLocalNote(alice, { note: second, published: original })
    expect(savedAgain.note.id).toBe(recovered.note.id)
    expect(savedAgain.note.content).toBe(second.content)
    const stored = await readLocalNotebook(alice)
    expect(stored.records).toHaveLength(2)
    expect(stored.records.find(({ note }) => note.id === remote.id)?.note).toEqual(remote)
    expect(stored.pending).toEqual([recovered.note.id])
    expect(stored.recoveries).toEqual([{
      id: original.id, createdAt: original.createdAt, lineage: original.crdt!.lineage, targetId: recovered.note.id,
    }])
    expect(await resolveLocalNoteDestination(alice, original)).toEqual({ scope: alice, id: recovered.note.id })
  })

  it('resolves only exact recovery identities within the captured account', async () => {
    const original = note('same', 'Original text'), remote = note('same', 'Remote text')
    const copied = { ...original, id: 'separate-copy' }
    await writeLocalNote(alice, record(original))
    const recovered = (await acknowledgeLocalNote(alice, record(remote))).recovered!
    await writeLocalNote(alice, record(copied))
    await writeLocalNote(bob, record(original))
    const differentCreation = { ...original, createdAt: '2026-10-15T12:00:00Z' }
    expect(await resolveLocalNoteDestination(alice, differentCreation)).toEqual({ scope: alice, id: original.id })
    await expect(writeLocalNote(alice, record(differentCreation))).rejects.toThrow('different editing histories')
    expect(await resolveLocalNoteDestination(alice, copied)).toEqual({ scope: alice, id: copied.id })
    expect(await resolveLocalNoteDestination(bob, original)).toEqual({ scope: bob, id: original.id })
    expect((await readLocalNotebook(bob)).recoveries).toBeUndefined()
    expect((await readLocalNotebook(alice)).records.find(({ note }) => note.id === recovered.note.id)?.note.content).toBe(original.content)
  })

  it('keeps remote acknowledgements at their real ID even when that history has a local recovery', async () => {
    const original = note('same', 'History A'), remote = note('same', 'History B')
    await writeLocalNote(alice, record(original))
    const firstRecovery = (await acknowledgeLocalNote(alice, record(remote))).recovered!
    const received = await acknowledgeLocalNote(alice, record(original))
    expect(received.record.note.id).toBe(original.id)
    expect(received.record.note.content).toBe(original.content)
    expect(received.recovered?.note.content).toBe(remote.content)
    expect((await readLocalNotebook(alice)).records.find(({ note }) => note.id === firstRecovery.note.id)?.note.content).toBe(original.content)
  })

  it('follows chained recovery destinations after a guest claim without crossing accounts', async () => {
    const original = note('same', 'Guest history'), remote = note('same', 'Remote original ID')
    await writeLocalNote(guest, record(original))
    await adoptGuestNotebook(guest, alice)
    const first = (await acknowledgeLocalNote(alice, record(remote))).recovered!
    const second = (await acknowledgeLocalNote(alice, record(note(first.note.id, 'Remote recovered ID')))).recovered!
    await closeLocalNotebook()
    const changed = editNote(original, { content: 'Guest history continued' })
    expect((await writeLocalNote(guest, record(changed))).note.id).toBe(second.note.id)
    expect((await writeLocalNote(alice, record(changed))).note.id).toBe(second.note.id)
    expect(await resolveLocalNoteDestination(guest, original)).toEqual({ scope: alice, id: second.note.id })
    const stored = await readLocalNotebook(alice)
    expect(stored.recoveries?.find(({ id }) => id === original.id)?.targetId).toBe(second.note.id)
    expect(stored.records.find(({ note }) => note.id === second.note.id)?.note.content).toBe(changed.content)
    expect((await adoptGuestNotebook(guest, bob)).records).toEqual([])
  })

  it('upgrades the existing v1 database without losing notes, pending edits, folders, selection, or guest claims', async () => {
    const original = note('same', 'Persisted v1 text')
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open('pubky-notes:local:v1', 1)
      opening.onupgradeneeded = () => {
        const db = opening.result
        db.createObjectStore('notes', { keyPath: ['scope', 'id'] }).createIndex('scope', 'scope')
        db.createObjectStore('metadata', { keyPath: 'scope' })
        const claims = db.createObjectStore('claims', { keyPath: ['scope', 'id'] })
        claims.createIndex('scope', 'scope')
        claims.createIndex('destination', ['targetScope', 'targetId'])
        opening.transaction!.objectStore('notes').put({ scope: alice, id: original.id, record: record(original), pending: true })
        opening.transaction!.objectStore('metadata').put({ scope: alice, folders: ['Drafts'], foldersPending: true, activeId: original.id })
        claims.put({ scope: guest, id: original.id, targetScope: alice, targetId: original.id })
      }
      opening.onerror = () => reject(opening.error)
      opening.onsuccess = () => { opening.result.close(); resolve() }
    })
    expect(await readLocalNotebook(alice)).toEqual({
      records: [record(original)], pending: [original.id], folders: ['Drafts'], foldersPending: true, activeId: original.id,
    })
    const recovered = (await acknowledgeLocalNote(alice, record(note('same', 'Different remote history')))).recovered!
    expect((await writeLocalNote(guest, record(editNote(original, { content: 'V1 draft continued' })))).note.id).toBe(recovered.note.id)
  })

  it('rolls back both history replacement and its redirect if recovery cannot commit', async () => {
    const original = note('same', 'Original text'), remote = note('same', 'Remote text')
    await writeLocalNote(alice, record(original))
    const put = IDBObjectStore.prototype.put
    const sabotage = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const result = put.call(this, value, key)
      if (this.name === 'recoveries') this.transaction.abort()
      return result
    })
    await expect(acknowledgeLocalNote(alice, record(remote))).rejects.toThrow()
    sabotage.mockRestore()
    await closeLocalNotebook()
    const stored = await readLocalNotebook(alice)
    expect(stored.records).toEqual([record(original)])
    expect(stored.recoveries).toBeUndefined()
    expect(await resolveLocalNoteDestination(alice, original)).toEqual({ scope: alice, id: original.id })
    expect((await writeLocalNote(alice, record(editNote(original, { content: 'Original text continued' })))).note.id).toBe(original.id)
  })

  it('keeps new folder edits pending after an old acknowledgement or background refresh', async () => {
    await writeLocalFolders(alice, ['Original'])
    await writeLocalFolders(alice, ['Original', 'New'])
    await acknowledgeLocalFolders(alice, ['Original'])
    await acceptRemoteFolders(alice, ['Remote'])
    expect(await readLocalNotebook(alice)).toMatchObject({ folders: ['New', 'Original'], foldersPending: true })
    await acknowledgeLocalFolders(alice, ['Original', 'New'])
    expect((await readLocalNotebook(alice)).foldersPending).toBe(false)
    await acceptRemoteFolders(alice, ['Remote'])
    expect(await readLocalNotebook(alice)).toMatchObject({ folders: ['Remote'], foldersPending: false })
  })

  it('preserves deletion operations in the outbox instead of forgetting the note', async () => {
    const deleted = editNote(note(), { deleted: true })
    await writeLocalNote(alice, record(deleted))
    const stored = await readLocalNotebook(alice)
    expect(stored.records[0].note).toMatchObject({ deleted: true })
    expect(stored.pending).toEqual([deleted.id])
  })

  it('does not report success when the IndexedDB transaction aborts after put', async () => {
    await readLocalNotebook(alice)
    const put = IDBObjectStore.prototype.put
    const sabotage = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      const result = put.apply(this, args)
      this.transaction.abort()
      return result
    })
    await expect(writeLocalNote(alice, record(note()))).rejects.toThrow()
    sabotage.mockRestore()
    expect((await readLocalNotebook(alice)).records).toEqual([])
  })

  it('rolls back an adoption entirely if its destination cannot be committed', async () => {
    const draft = note()
    await writeLocalNote(guest, record(draft))
    const put = IDBObjectStore.prototype.put
    const sabotage = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const result = put.call(this, value, key)
      if (this.name === 'notes') this.transaction.abort()
      return result
    })
    await expect(adoptGuestNotebook(guest, alice)).rejects.toThrow()
    sabotage.mockRestore()
    expect((await readLocalNotebook(guest)).records).toEqual([record(draft)])
    expect((await readLocalNotebook(alice)).records).toEqual([])
    // A failed transaction must not leave a claim that diverts the guest's edits.
    await writeLocalNote(guest, record(editNote(draft, { content: 'Still a guest draft' })))
    expect((await readLocalNotebook(guest)).records[0].note.content).toBe('Still a guest draft')
  })

  it('fails clearly without persistent browser storage and rejects invalid account boundaries', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await expect(writeLocalNote(guest, record(note()))).rejects.toThrow('unavailable')
    await expect(readLocalNotebook('')).rejects.toThrow('scope')
    await expect(adoptGuestNotebook(alice, bob)).rejects.toThrow('Guest notes')
    await expect(adoptGuestNotebook(guest, 'testnet:alice')).rejects.toThrow('same network')
  })
})
