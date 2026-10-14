import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@synonymdev/pubky'
import { APP_PATHS } from '../config'

const mocks = vi.hoisted(() => ({ publicGet: vi.fn() }))
vi.mock('./pubky', () => ({ getPubky: () => ({ publicStorage: { get: mocks.publicGet } }) }))
vi.mock('@synonymdev/pubky', () => ({
  PubkyResource: {
    parse: (url: string) => {
      const parsed = new URL(url)
      return { owner: { z32: () => parsed.hostname }, path: parsed.pathname, free: () => undefined }
    },
  },
  PublicKey: {
    from: (owner: string) => {
      if (!/^[a-z0-9]+$/.test(owner)) throw new Error('Invalid owner')
      return { z32: () => owner, free: () => undefined }
    },
  },
}))

import {
  createNote, deleteNote, listNotes, loadPublicNote, MAX_CONTENT_LENGTH, MAX_NOTE_BYTES,
  notePath, publishNote, saveNote, unpublishNote,
} from './notes'
import type { Note } from './notes'
import { editNote, ensureCrdt, initializeNote, mergeNotes, noteRevision } from './crdt'

const fixture = (id = 'note-1', content = '# A private thought'): Note => ({
  id, title: 'A note', content,
  createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z',
})
const missing = { data: { statusCode: 404 } }

function makeSession(initial: Array<[string, Note]> = []) {
  const files = new Map<string, Note>(initial)
  const storage = {
    putJson: vi.fn(async (path: string, note: Note) => { files.set(path, note) }),
    exists: vi.fn(async (path: string) => files.has(path)),
    delete: vi.fn(async (path: string) => { if (!files.delete(path)) throw missing }),
    get: vi.fn(async (path: string) => {
      if (!files.has(path)) throw missing
      return new Response(JSON.stringify(files.get(path)))
    }),
    list: vi.fn(async (folder: string, cursor: string | null, _reverse: boolean, limit: number) => {
      const urls = [...files.keys()].filter((path) => path.startsWith(folder)).sort().map((path) => `pubky://owner${path}`)
      const start = cursor ? urls.indexOf(cursor) + 1 : 0
      return urls.slice(start, start + limit)
    }),
    lock: vi.fn(async (path: string) => ({ path, free: vi.fn() })),
    unlock: vi.fn(async () => undefined),
    refreshLock: vi.fn(async () => undefined),
    putTextLocked: vi.fn(async (lock: { path: string }, text: string) => { files.set(lock.path, JSON.parse(text)) }),
    deleteLocked: vi.fn(async (lock: { path: string }) => { if (!files.delete(lock.path)) throw missing }),
  }
  const session = { storage, info: { publicKey: { z32: () => 'owner' } } } as unknown as Session
  return { session, storage, files }
}

beforeEach(() => vi.clearAllMocks())

describe('private notes and explicit public snapshots', () => {
  it('creates an unpublished note and saves only beneath /priv', async () => {
    const { session, storage } = makeSession()
    const fresh = createNote()
    expect(fresh.id).toMatch(/^[a-z0-9-]+$/)
    const saved = await saveNote(session, { ...fresh, content: '# Draft', title: '  My note  ' })
    expect(saved.title).toBe('  My note  ')
    expect(saved.updatedAt).toBe(fresh.updatedAt)
    expect(storage.putTextLocked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: `${APP_PATHS.private}${fresh.id}.json` }), JSON.stringify(saved))
  })

  it('saves the private original before publishing, leaving later edits private', async () => {
    const { session, storage, files } = makeSession()
    const published = await publishNote(session, fixture())
    expect(storage.putTextLocked.mock.calls.map(([lock]) => lock.path)).toEqual([
      notePath('private', published.id), notePath('public', published.id),
    ])
    await saveNote(session, editNote(files.get(notePath('private', published.id))!, { content: 'An unpublished change' }))
    expect(files.get(notePath('public', published.id))?.content).toBe('# A private thought')
    expect(files.get(notePath('private', published.id))?.content).toBe('An unpublished change')
  })

  it('preserves empty titles and surrounding spaces without changing the revision', async () => {
    for (const title of ['', '  A title  ']) {
      const { session, files } = makeSession()
      const note = { ...fixture(), title }
      await expect(publishNote(session, note)).resolves.toEqual(note)
      expect(files.get(notePath('private', note.id))).toMatchObject(note)
      expect(files.get(notePath('public', note.id))).toEqual(note)
    }
  })

  it('does not publish anything when the private save fails', async () => {
    const { session, storage } = makeSession()
    storage.putTextLocked.mockRejectedValueOnce(new Error('Permission denied'))
    await expect(publishNote(session, fixture())).rejects.toThrow('Permission denied')
    expect(storage.putTextLocked).toHaveBeenCalledTimes(1)
    expect(storage.putTextLocked.mock.calls[0][0].path).toMatch(/^\/priv\//)
  })

  it('retains the saved original and reports a failed public write', async () => {
    const { session, storage, files } = makeSession()
    storage.putTextLocked.mockImplementation(async (lock, text) => {
      if (lock.path.startsWith('/pub/')) throw new Error('Public write failed')
      files.set(lock.path, JSON.parse(text))
    })
    await expect(publishNote(session, fixture())).rejects.toThrow('Public write failed')
    expect(files.has(notePath('private', 'note-1'))).toBe(true)
    expect(files.has(notePath('public', 'note-1'))).toBe(false)
  })

  it('unpublishes without changing the private original and tolerates already removed public copies', async () => {
    const note = fixture()
    const { session, files } = makeSession([
      [notePath('private', note.id), note], [notePath('public', note.id), note],
    ])
    await unpublishNote(session, note.id)
    await unpublishNote(session, note.id)
    expect(files.has(notePath('private', note.id))).toBe(true)
    expect(files.has(notePath('public', note.id))).toBe(false)
  })

  it('restores an orphaned public snapshot privately before unpublishing it', async () => {
    const note = fixture()
    const { session, storage, files } = makeSession([[notePath('public', note.id), note]])
    await unpublishNote(session, note.id)
    expect(files.get(notePath('private', note.id))).toMatchObject(note)
    expect(files.has(notePath('public', note.id))).toBe(false)
    expect(storage.putTextLocked.mock.invocationCallOrder[0]).toBeLessThan(storage.deleteLocked.mock.invocationCallOrder[0])
  })

  it('preserves an orphaned public snapshot when restoring its private original fails', async () => {
    const note = fixture()
    const { session, storage, files } = makeSession([[notePath('public', note.id), note]])
    storage.putTextLocked.mockRejectedValueOnce(new Error('Private storage unavailable'))
    await expect(unpublishNote(session, note.id)).rejects.toThrow('Private storage unavailable')
    expect(files.get(notePath('public', note.id))).toEqual(note)
    expect(storage.deleteLocked).not.toHaveBeenCalled()
  })

  it('deletes the public copy first and preserves private data if that fails', async () => {
    const { session, storage } = makeSession([[notePath('private', 'note-1'), fixture()]])
    storage.deleteLocked.mockRejectedValueOnce(new Error('Network unavailable'))
    await expect(deleteNote(session, 'note-1')).rejects.toThrow('Network unavailable')
    expect(storage.deleteLocked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: notePath('public', 'note-1') }))
  })

  it('preserves a private-only note as a recoverable tombstone after a public 404', async () => {
    const { session, storage, files } = makeSession([[notePath('private', 'note-1'), fixture()]])
    const deleted = await deleteNote(session, 'note-1')
    expect(storage.deleteLocked.mock.calls.map(([lock]) => lock.path)).toEqual([notePath('public', 'note-1')])
    expect(files.size).toBe(1)
    expect(deleted).toMatchObject({ deleted: true, content: fixture().content })
    expect(files.get(notePath('private', 'note-1'))).toEqual(deleted)
  })

  it('does not turn permission errors into successful unpublishing', async () => {
    const { session, storage } = makeSession([[notePath('private', 'note-1'), fixture()]])
    storage.deleteLocked.mockRejectedValueOnce({ data: { statusCode: 403 } })
    await expect(unpublishNote(session, 'note-1')).rejects.toEqual({ data: { statusCode: 403 } })
  })
})

describe('loading and validating notes', () => {
  it('ignores the private folder registry when listing notes', async () => {
    const note = fixture()
    const { session, storage } = makeSession([[notePath('private', note.id), note]])
    storage.list.mockImplementation(async (folder) => folder === APP_PATHS.private ? [
      `pubky://owner${APP_PATHS.private}folders`, `pubky://owner${notePath('private', note.id)}`,
    ] : [])
    await expect(listNotes(session)).resolves.toMatchObject([{ note, published: null }])
    expect(storage.get).toHaveBeenCalledExactlyOnceWith(notePath('private', note.id))
  })

  it('lists only the two current Notes roots without writing or deleting files', async () => {
    const { session, storage } = makeSession()
    await expect(listNotes(session)).resolves.toEqual([])
    expect(storage.list.mock.calls.map(([folder]) => folder)).toEqual(['/priv/notes/', '/pub/notes/'])
    expect(storage.putJson).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
  })

  it('pages through private notes and reconciles actual public copies', async () => {
    const privateNotes: Array<[string, Note]> = Array.from({ length: 101 }, (_, index) => {
      const note = fixture(`note-${String(index).padStart(3, '0')}`)
      return [notePath('private', note.id), note]
    })
    const oldPublic = fixture('note-000', 'Published snapshot')
    const { session, storage } = makeSession([...privateNotes, [notePath('public', oldPublic.id), oldPublic]])
    const notes = await listNotes(session)
    expect(notes).toHaveLength(101)
    expect(notes.find(({ note }) => note.id === oldPublic.id)?.published?.content).toBe('Published snapshot')
    expect(notes.find(({ note }) => note.id === 'note-001')?.published).toBeNull()
    const privateCalls = storage.list.mock.calls.filter(([folder]) => folder === APP_PATHS.private)
    expect(privateCalls).toHaveLength(2)
    expect(privateCalls[1][1]).toBe(`pubky://owner${notePath('private', 'note-099')}`)
  })

  it('retains discoverability of public copies whose private original is missing', async () => {
    const note = fixture()
    const { session } = makeSession([[notePath('public', note.id), note]])
    await expect(listNotes(session)).resolves.toMatchObject([{ note, published: note }])
  })

  it('treats missing folders as empty but propagates permission and network failures', async () => {
    const { session, storage } = makeSession()
    storage.list.mockRejectedValue(missing)
    await expect(listNotes(session)).resolves.toEqual([])
    storage.list.mockRejectedValue({ data: { statusCode: 403 } })
    await expect(listNotes(session)).rejects.toEqual({ data: { statusCode: 403 } })
  })

  it('rejects cross-account listing entries before fetching them', async () => {
    const { session, storage } = makeSession()
    storage.list.mockImplementation(async (folder) => folder === APP_PATHS.private
      ? [`pubky://attacker${notePath('private', 'note-1')}`] : [])
    await expect(listNotes(session)).rejects.toThrow('outside this account')
    expect(storage.get).not.toHaveBeenCalled()
  })

  it('rejects note IDs that can escape the namespace', async () => {
    const { session, storage } = makeSession()
    await expect(saveNote(session, fixture('../other-app'))).rejects.toThrow('Invalid note ID')
    expect(storage.putJson).not.toHaveBeenCalled()
  })

  it('does not trust a note body to choose its filename', async () => {
    const { session } = makeSession([[notePath('private', 'note-1'), fixture('different-id')]])
    await expect(listNotes(session)).rejects.toThrow('Invalid note data')
  })

  it('rejects oversized input before sending any write', async () => {
    const { session, storage } = makeSession()
    await expect(saveNote(session, fixture('note-1', 'x'.repeat(MAX_CONTENT_LENGTH + 1)))).rejects.toThrow('Invalid note data')
    expect(storage.putJson).not.toHaveBeenCalled()
  })

  it('enforces the download limit even without content-length', async () => {
    const { session, storage } = makeSession([[notePath('private', 'note-1'), fixture()]])
    storage.get.mockResolvedValue(new Response('x'.repeat(MAX_NOTE_BYTES + 1)))
    await expect(listNotes(session)).rejects.toThrow('too large to open')
  })

  it('loads a public note through unauthenticated public storage only', async () => {
    mocks.publicGet.mockResolvedValue(new Response(JSON.stringify(fixture())))
    await expect(loadPublicNote('owner', 'note-1')).resolves.toEqual(fixture())
    expect(mocks.publicGet).toHaveBeenCalledExactlyOnceWith(`pubkyowner${notePath('public', 'note-1')}`)
  })

  it.each([404, 410, 403, 500])('returns a public read error (%i) without trying another namespace', async (statusCode) => {
    mocks.publicGet.mockReset().mockRejectedValueOnce({ data: { statusCode } })
    await expect(loadPublicNote('owner', 'note-1')).rejects.toEqual({ data: { statusCode } })
    expect(mocks.publicGet).toHaveBeenCalledExactlyOnceWith('pubkyowner/pub/notes/note-1.json')
  })
})


describe('flat storage and private folder metadata', () => {
  it('uses exact flat paths regardless of a note’s folder', async () => {
    expect(APP_PATHS).toEqual({ private: '/priv/notes/', public: '/pub/notes/' })
    const { session, files } = makeSession()
    await saveNote(session, { ...fixture(), folder: ' Work / Ideas ' })
    expect([...files.keys()]).toEqual(['/priv/notes/note-1.json'])
    expect(files.get('/priv/notes/note-1.json')?.folder).toBe('Work/Ideas')
  })

  it('never exposes private folder names in published snapshots', async () => {
    const { session, files } = makeSession()
    const snapshot = await publishNote(session, { ...fixture(), folder: 'Secret/Project' })
    expect(files.get(notePath('private', 'note-1'))?.folder).toBe('Secret/Project')
    expect(snapshot).toEqual(fixture())
    expect(files.get(notePath('public', 'note-1'))).toEqual(fixture())
    await saveNote(session, editNote(files.get(notePath('private', 'note-1'))!, { folder: 'Other/Folder' }))
    expect(files.get(notePath('public', 'note-1'))).toEqual(fixture())
  })

  it('accepts unfiled notes and rejects malformed metadata', async () => {
    const { session, storage } = makeSession()
    await saveNote(session, fixture())
    await saveNote(session, { ...fixture(), folder: '' })
    expect(JSON.parse(storage.putTextLocked.mock.calls[1][1])).not.toHaveProperty('folder')
    for (const folder of [null, 42, ['Work'], '../other', 'Work/../../other']) {
      await expect(saveNote(session, { ...fixture(), folder } as Note)).rejects.toThrow()
    }
    expect(storage.putTextLocked).toHaveBeenCalledTimes(2)
  })
})

describe('locked CRDT synchronization', () => {
  it('locks both paths in CLI order, merges remote edits, and acknowledges the actual stored state', async () => {
    const base = initializeNote({ ...fixture(), content: 'First\nLast' })
    const local = editNote(base, { content: 'First local\nLast' })
    const remote = editNote(base, { content: 'First\nLast remote' })
    const { session, storage, files } = makeSession([[notePath('private', base.id), remote]])
    const saved = await saveNote(session, local)
    expect(saved.content).toBe('First local\nLast remote')
    expect(saved).toEqual(mergeNotes(local, remote))
    expect(saved).toEqual(files.get(notePath('private', base.id)))
    expect(storage.lock.mock.calls.map(([path]) => path)).toEqual([notePath('private', base.id), notePath('public', base.id)])
    expect(storage.putJson).not.toHaveBeenCalled()
    expect(storage.get.mock.calls.filter(([path]) => path === notePath('private', base.id))).toHaveLength(2)
    expect(storage.unlock).toHaveBeenCalledTimes(2)
  })

  it('preserves both histories when legacy versions or independent note IDs collide', async () => {
    const { session, storage, files } = makeSession([[notePath('private', 'note-1'), fixture()]])
    await expect(saveNote(session, { ...fixture(), content: 'Different offline legacy version' })).rejects.toThrow('different editing histories')
    expect(storage.putTextLocked).not.toHaveBeenCalled()
    expect(files.get(notePath('private', 'note-1'))).toEqual(fixture())
  })

  it('fails closed when locks are unsupported or expire and releases acquired locks', async () => {
    const { session, storage } = makeSession()
    storage.lock.mockRejectedValueOnce({ data: { statusCode: 405 } })
    await expect(saveNote(session, fixture())).rejects.toThrow('safe note locking')
    expect(storage.putTextLocked).not.toHaveBeenCalled()
    expect(storage.putJson).not.toHaveBeenCalled()
    storage.refreshLock.mockRejectedValueOnce({ data: { statusCode: 412 } })
    await expect(saveNote(session, fixture())).rejects.toThrow('retained for retry')
    expect(storage.putTextLocked).not.toHaveBeenCalled()
    expect(storage.unlock).toHaveBeenCalledTimes(2)
  })

  it('does not acknowledge a write that the homeserver accepts but fails to retain', async () => {
    const base = await ensureCrdt(fixture())
    const { session, storage } = makeSession([[notePath('private', base.id), base]])
    storage.putTextLocked.mockResolvedValueOnce(undefined)
    await expect(saveNote(session, editNote(base, { content: 'Not actually retained' }))).rejects.toThrow('could not be verified')
    expect(storage.unlock).toHaveBeenCalledTimes(2)
  })

  it('rejects a corrupted remote snapshot without writing over it', async () => {
    const base = initializeNote(fixture())
    const { session, storage } = makeSession([[notePath('private', base.id), { ...base, content: 'Corrupted' }]])
    await expect(saveNote(session, base)).rejects.toThrow('does not match')
    expect(storage.putTextLocked).not.toHaveBeenCalled()
  })

  it('publishes only reviewed text, never merged remote edits or any private history', async () => {
    const base = initializeNote({ ...fixture(), content: 'First\nLast', folder: 'Private/Folder' })
    const reviewed = editNote(base, { content: 'First reviewed\nLast' })
    const remote = editNote(base, { content: 'First\nLast secret' })
    const { session, files } = makeSession([[notePath('private', base.id), remote]])
    const snapshot = await publishNote(session, reviewed)
    expect(snapshot.content).toBe('First reviewed\nLast')
    expect(Object.keys(snapshot).sort()).toEqual(['content', 'createdAt', 'id', 'title', 'updatedAt'])
    expect(files.get(notePath('private', base.id))?.content).toBe('First reviewed\nLast secret')
    expect(files.get(notePath('public', base.id))).toEqual(snapshot)
  })

  it('keeps deleted notes discoverable and concurrent edits recoverable without reviving them', async () => {
    const base = initializeNote(fixture())
    const { session } = makeSession([[notePath('private', base.id), base]])
    const deleted = await deleteNote(session, base)
    const saved = await saveNote(session, editNote(base, { content: 'Offline changes' }))
    expect(saved).toMatchObject({ deleted: true, content: 'Offline changes' })
    expect(noteRevision(saved)).not.toBe(noteRevision(deleted))
    await expect(listNotes(session)).resolves.toEqual([{ note: saved, published: null }])
    await expect(publishNote(session, saved)).rejects.toThrow('Restore')
    const restored = await saveNote(session, editNote(saved, { deleted: false }))
    expect(restored.deleted).toBeUndefined()
    expect(restored.content).toBe('Offline changes')
  })
})
