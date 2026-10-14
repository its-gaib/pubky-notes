import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@synonymdev/pubky'
import { editNote, initializeNote, mergeNotes, LineageConflictError } from './crdt'
import type { Note } from './notes'
import { acknowledgeLocalNote, closeLocalNotebook, readLocalNotebook, writeLocalFolders, writeLocalNote } from './local-notebook'
import { mergeRemoteNotebook, scopeForSession, synchronizeNotebook, uploadNotebook } from './notebook-sync'

const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), loadFolders: vi.fn(), saveFolders: vi.fn() }))
vi.mock('./notes', () => ({ listNotes: mocks.list, saveNote: mocks.save, deleteNote: mocks.remove }))
vi.mock('./folder-store', async original => ({ ...await original<typeof import('./folder-store')>(), loadFolders: mocks.loadFolders, saveFolders: mocks.saveFolders }))
const session = { info: { publicKey: { z32: () => 'y'.repeat(52) } } } as unknown as Session
const scope = scopeForSession(session)
const row = (note: Note) => ({ note, published: null })
function note(id = 'test-note') { return initializeNote({ id, title: 'Draft', content: 'First line\nSecond line', createdAt: '2026-10-14T12:00:00Z', updatedAt: '2026-10-14T12:00:00Z' }) }

beforeEach(async () => {
  await closeLocalNotebook()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.resetAllMocks()
  mocks.list.mockResolvedValue([])
  mocks.loadFolders.mockResolvedValue([])
  mocks.save.mockImplementation(async (_session, value) => value)
  mocks.remove.mockImplementation(async (_session, value) => editNote(value, { deleted: true }))
  mocks.saveFolders.mockImplementation(async (_session, folders) => folders)
})
afterEach(async () => { await closeLocalNotebook(); vi.unstubAllGlobals() })

describe('durable homeserver synchronization', () => {
  it('keeps a failed upload pending across database reopen', async () => {
    const draft = note()
    await writeLocalNote(scope, row(draft))
    mocks.save.mockRejectedValue(new Error('Homeserver unavailable'))
    await expect(uploadNotebook(session, scope)).rejects.toThrow('Homeserver unavailable')
    await closeLocalNotebook()
    expect((await readLocalNotebook(scope)).pending).toEqual([draft.id])
    expect((await readLocalNotebook(scope)).records[0].note.content).toBe(draft.content)
  })

  it('merges remote edits before uploading the complete local result', async () => {
    const base = note()
    await writeLocalNote(scope, row(editNote(base, { content: 'Local first line\nSecond line' })))
    mocks.list.mockResolvedValue([row(editNote(base, { content: 'First line\nRemote second line' }))])
    const result = await synchronizeNotebook(session, scope)
    expect(result.records[0].note.content).toBe('Local first line\nRemote second line')
    expect(result.pending).toEqual([])
    expect(mocks.save.mock.calls[0][1].content).toBe('Local first line\nRemote second line')
  })

  it('retains edits made while a save is in flight', async () => {
    const base = note()
    await writeLocalNote(scope, row(base))
    let finish!: (value: Note) => void
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    mocks.save.mockImplementation(() => { started(); return new Promise(resolve => { finish = resolve }) })
    const pending = uploadNotebook(session, scope)
    await startedPromise
    const newer = editNote(base, { content: 'Typed during upload' })
    await writeLocalNote(scope, row(newer))
    finish(base)
    const result = await pending
    expect(result.records[0].note.content).toBe(newer.content)
    expect(result.pending).toEqual([base.id])
  })

  it('finishes public removal when a remote deletion merges into a pending draft', async () => {
    const base = note()
    await writeLocalNote(scope, row(editNote(base, { content: 'Unsent local text' })))
    const deleted = editNote(base, { deleted: true })
    mocks.save.mockImplementation(async (_session, draft) => mergeNotes(draft, deleted))
    const result = await uploadNotebook(session, scope)
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(result.records[0].note.deleted).toBe(true)
    expect(result.records[0].note.content).toBe('Unsent local text')
    expect(result.pending).toEqual([])
  })

  it('preserves incompatible legacy history in a recovery copy and uploads it', async () => {
    const local = note()
    const remote = note()
    await writeLocalNote(scope, row(local))
    mocks.list.mockResolvedValue([row(remote)])
    mocks.save.mockRejectedValueOnce(new LineageConflictError()).mockImplementation(async (_session, draft) => draft)
    const result = await uploadNotebook(session, scope)
    expect(result.records).toHaveLength(2)
    expect(result.records.find(record => record.note.id !== local.id)?.note.title).toContain('(recovered)')
    expect(result.pending).toEqual([])
  })

  it('uploads later edits from a stale tab to the same recovery copy after reopening storage', async () => {
    const original = note()
    const replacement = editNote(note(), { content: 'Independent homeserver version' })
    const remote = new Map<string, Note>([[replacement.id, replacement]])
    mocks.list.mockImplementation(async () => [...remote.values()].map(row))
    mocks.save.mockImplementation(async (_session, draft: Note) => {
      const existing = remote.get(draft.id)
      const saved = existing ? mergeNotes(existing, draft) : draft
      remote.set(saved.id, saved)
      return saved
    })
    await writeLocalNote(scope, row(original))
    const recovered = await synchronizeNotebook(session, scope)
    const recoveryId = recovered.records.find(record => record.note.id !== original.id)!.note.id
    await closeLocalNotebook()

    const later = editNote(original, { content: 'Latest edits from the stale tab' })
    await writeLocalNote(scope, row(later))
    const synchronized = await synchronizeNotebook(session, scope)

    expect(synchronized.records).toHaveLength(2)
    expect(synchronized.pending).toEqual([])
    expect(remote.get(original.id)).toEqual(replacement)
    expect(remote.get(recoveryId)?.content).toBe(later.content)
    expect(synchronized.records.find(record => record.note.id === recoveryId)?.published).toBeNull()
  })

  it('keeps folders pending when the homeserver does not retain the write', async () => {
    await writeLocalFolders(scope, ['Work'])
    await expect(uploadNotebook(session, scope)).rejects.toThrow('did not retain')
    expect((await readLocalNotebook(scope)).foldersPending).toBe(true)
    mocks.loadFolders.mockResolvedValue(['Work'])
    expect((await uploadNotebook(session, scope)).foldersPending).toBe(false)
  })

  it('never uploads a cached notebook through another account', async () => {
    await writeLocalNote('mainnet:another-account', row(note()))
    await expect(uploadNotebook(session, 'mainnet:another-account')).rejects.toThrow('different Pubky account')
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('retains offline drafts and pending folders when merging an empty server notebook', async () => {
    const draft = note()
    await writeLocalNote(scope, row(draft))
    await writeLocalFolders(scope, ['Offline'])
    const merged = await mergeRemoteNotebook(scope, [], [])
    expect(merged.records[0].note.content).toBe(draft.content)
    expect(merged.pending).toEqual([draft.id])
    expect(merged.folders).toEqual(['Offline'])
    await acknowledgeLocalNote(scope, row(draft))
  })
})
