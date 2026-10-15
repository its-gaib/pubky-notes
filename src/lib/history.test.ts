import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  checkpointNote, decode, editNote, encode, initializeNote, listNoteVersions, MAX_NOTE_VERSIONS,
  MAX_VERSION_SNAPSHOT_BYTES, mergeNotes, noteRevision, readNoteVersion, validateCrdtNote,
} from './crdt'
import type { CrdtNote } from './crdt'
import { createSharedNote, joinSharedNote, SharedNoteDocument } from './shared-note'

const initialDate = '2026-10-15T10:00:00.000Z'
const laterDate = '2026-10-15T10:01:00.000Z'
const fixture = (): CrdtNote => initializeNote({ id: 'history-note', title: 'A title', content: 'First line\nLast line', createdAt: initialDate, updatedAt: initialDate, folder: 'Private' })

function mutateHistory(note: CrdtNote, mutate: (history: Y.Map<unknown>, doc: Y.Doc) => void): CrdtNote {
  const doc = new Y.Doc({ gc: false })
  try {
    Y.applyUpdate(doc, decode(note.crdt!.version === 2 ? note.crdt!.personal : note.crdt!.update))
    mutate(doc.getMap('history'), doc)
    const update = encode(Y.encodeStateAsUpdate(doc))
    return { ...note, crdt: note.crdt!.version === 2 ? { ...note.crdt!, personal: update } : { ...note.crdt!, update } }
  } finally { doc.destroy() }
}

describe('saved note versions', () => {
  it('records a baseline and only checkpoints saved text changes, including deletion-only edits', () => {
    const base = fixture()
    expect(listNoteVersions(base)).toEqual([{ id: 'initial', recordedAt: initialDate }])
    const edited = editNote(base, { title: 'Changed title', content: 'First line' })
    expect(listNoteVersions(edited)).toHaveLength(1)
    const saved = checkpointNote(edited, { recordedAt: laterDate })
    const versions = listNoteVersions(saved)
    expect(versions).toHaveLength(2)
    expect(readNoteVersion(saved, versions[0]!.id)).toEqual({ title: base.title, content: base.content })
    expect(readNoteVersion(saved, versions[1]!.id)).toEqual({ title: 'Changed title', content: 'First line' })
    const deletedOnly = checkpointNote(editNote(saved, { content: '' }))
    expect(readNoteVersion(deletedOnly, listNoteVersions(deletedOnly).at(-1)!.id).content).toBe('')
    expect(readNoteVersion(deletedOnly, versions[1]!.id).content).toBe('First line')
    expect(checkpointNote(saved)).toEqual(saved)
    const moved = editNote(saved, { folder: 'Elsewhere', deleted: true })
    expect(checkpointNote(moved)).toEqual(moved)
    expect(listNoteVersions(moved)).toHaveLength(2)
  })

  it('reads history without changing live state and restores text as a new version', () => {
    const base = fixture()
    const changed = checkpointNote(editNote(base, { title: 'New title', content: 'New content', folder: 'Current folder' }), { recordedAt: laterDate })
    const before = JSON.stringify(changed), revision = noteRevision(changed)
    const old = readNoteVersion(changed, 'initial')
    expect(JSON.stringify(changed)).toBe(before)
    expect(noteRevision(changed)).toBe(revision)
    const restored = checkpointNote(editNote(changed, old), { restoredFrom: 'initial' })
    expect(restored).toMatchObject({ id: changed.id, createdAt: changed.createdAt, folder: 'Current folder', title: base.title, content: base.content })
    expect(restored.crdt!.lineage).toBe(changed.crdt!.lineage)
    expect(listNoteVersions(restored)).toHaveLength(3)
    expect(listNoteVersions(restored).at(-1)!.restoredFrom).toBe('initial')
    expect(readNoteVersion(restored, listNoteVersions(changed)[1]!.id).content).toBe('New content')
  })

  it('preserves separate offline checkpoints when both branches merge in either order', () => {
    const base = fixture()
    const left = checkpointNote(editNote(base, { content: 'First line left\nLast line' }), { recordedAt: laterDate })
    const right = checkpointNote(editNote(base, { content: 'First line\nLast line right' }), { recordedAt: laterDate })
    const merged = mergeNotes(left, right)
    expect(mergeNotes(right, left)).toEqual(merged)
    expect(merged.content).toBe('First line left\nLast line right')
    expect(listNoteVersions(merged)).toHaveLength(3)
    expect(readNoteVersion(merged, listNoteVersions(left)[1]!.id).content).toBe(left.content)
    expect(readNoteVersion(merged, listNoteVersions(right)[1]!.id).content).toBe(right.content)
    const savedMerge = checkpointNote(merged)
    expect(listNoteVersions(savedMerge)).toHaveLength(4)
    expect(readNoteVersion(JSON.parse(JSON.stringify(savedMerge)), listNoteVersions(savedMerge).at(-1)!.id).content).toBe(merged.content)
  })

  it('keeps checkpoint order when the local clock does not advance or moves backwards', () => {
    const base = fixture()
    const one = checkpointNote(editNote(base, { content: 'One' }), { recordedAt: initialDate })
    const two = checkpointNote(editNote(one, { content: 'Two' }), { recordedAt: '2026-10-14T10:00:00.000Z' })
    expect(listNoteVersions(two).map(version => readNoteVersion(two, version.id).content)).toEqual([base.content, 'One', 'Two'])
  })

  it('starts a shared copy at current text and keeps each collaborator’s checkpoints private', () => {
    const original = checkpointNote(editNote(initializeNote({ ...fixture(), crdt: undefined, content: 'Private deleted secret' }), { content: 'Visible text' }))
    const shared = createSharedNote(original)
    expect(listNoteVersions(shared)).toHaveLength(1)
    expect(readNoteVersion(shared, listNoteVersions(shared)[0]!.id).content).toBe('Visible text')
    const alice = new SharedNoteDocument(shared)
    const bob = new SharedNoteDocument(joinSharedNote(alice.descriptor, alice.getUpdate()))
    try {
      const checkpointed = checkpointNote(alice.edit({ content: 'Shared edit' }), { recordedAt: '2099-01-01T00:00:00.000Z' })
      alice.mergeLocal(checkpointed)
      expect(listNoteVersions(alice.note)).toHaveLength(2)
      const wire = alice.getUpdate()
      const wireText = new TextDecoder().decode(wire)
      expect(wireText).not.toContain('Private deleted secret')
      expect(wireText).not.toContain('history')
      expect(wireText).not.toContain('2099-01-01T00:00:00.000Z')
      expect(wireText).not.toContain(listNoteVersions(checkpointed)[1]!.id)
      bob.applyPeerUpdate(wire)
      expect(listNoteVersions(bob.note)).toHaveLength(1)
      expect(readNoteVersion(bob.note, listNoteVersions(bob.note)[0]!.id).content).toBe('Visible text')
      bob.mergeLocal(checkpointNote(bob.note))
      expect(listNoteVersions(bob.note)).toHaveLength(2)
      const joiningLater = joinSharedNote(alice.descriptor, wire)
      expect(listNoteVersions(joiningLater)).toHaveLength(1)
      expect(readNoteVersion(joiningLater, listNoteVersions(joiningLater)[0]!.id).content).toBe('Shared edit')
    } finally { alice.destroy(); bob.destroy() }
  })

  it('merges personal checkpoints from the same account without changing shared wire data', () => {
    const shared = createSharedNote(fixture())
    const changed = editNote(shared, { content: 'Later text' })
    const saved = checkpointNote(changed)
    expect(saved.crdt!.update).toBe(changed.crdt!.update)
    expect(noteRevision(saved)).not.toBe(noteRevision(changed))
    expect(mergeNotes(changed, saved)).toEqual(saved)
    expect(listNoteVersions(mergeNotes(saved, changed))).toHaveLength(2)
  })

  it('keeps independent join baselines when the same account joins from two devices', () => {
    const alice = new SharedNoteDocument(createSharedNote(fixture()))
    try {
      const first = joinSharedNote(alice.descriptor, alice.getUpdate())
      alice.edit({ content: 'Text observed by a later device' })
      const second = joinSharedNote(alice.descriptor, alice.getUpdate())
      const merged = mergeNotes(first, second)
      const versions = listNoteVersions(merged)
      expect(versions).toHaveLength(2)
      expect(readNoteVersion(merged, listNoteVersions(first)[0]!.id).content).toBe(first.content)
      expect(readNoteVersion(merged, listNoteVersions(second)[0]!.id).content).toBe(second.content)
    } finally { alice.destroy() }
  })

  it('rejects malformed checkpoint metadata, absent references, and invalid encodings', () => {
    const base = fixture(), id = crypto.randomUUID()
    const good = { recordedAt: laterDate, snapshot: encode(Y.encodeSnapshot(Y.emptySnapshot)) }
    for (const entry of [null, [], { ...good, unknown: true }, { ...good, recordedAt: 'yesterday' }, { ...good, restoredFrom: id },
      { ...good, snapshot: 'AAAA' }, { ...good, snapshot: `${good.snapshot}AAAA` }, { ...good, snapshot: 'A'.repeat(MAX_VERSION_SNAPSHOT_BYTES * 2) }]) {
      expect(() => validateCrdtNote(mutateHistory(base, history => history.set(id, entry)))).toThrow()
    }
    expect(() => validateCrdtNote(mutateHistory(base, history => history.set('invalid-id', good)))).toThrow('Invalid saved note version')
    const unrelated = new Y.Doc({ gc: false })
    try {
      unrelated.getText('content').insert(0, 'Unavailable')
      const snapshot = encode(Y.encodeSnapshot(Y.snapshot(unrelated)))
      expect(() => validateCrdtNote(mutateHistory(base, history => history.set(id, { ...good, snapshot })))).toThrow('unavailable')
    } finally { unrelated.destroy() }
    expect(() => checkpointNote(editNote(base, { content: 'New' }), { restoredFrom: id })).toThrow('no longer exists')
    expect(() => checkpointNote(base, { recordedAt: 'invalid' })).toThrow('date')
    expect(() => readNoteVersion(base, id)).toThrow('does not exist')
  })

  it('rejects checkpoints whose text was discarded by a garbage-collecting document', () => {
    const base = fixture()
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, decode(base.crdt!.update))
      doc.getText('content').delete(0, doc.getText('content').length)
      const missing = { ...base, content: '', crdt: { ...base.crdt!, update: encode(Y.encodeStateAsUpdate(doc)) } }
      expect(() => validateCrdtNote(missing)).toThrow('discarded editing history')
    } finally { doc.destroy() }
  })

  it('rejects deletion or replacement of saved versions and enforces a bounded history without pruning', () => {
    const base = fixture()
    expect(() => validateCrdtNote(mutateHistory(base, history => history.delete('initial')))).toThrow('cannot be changed or deleted')
    expect(() => validateCrdtNote(mutateHistory(base, history => history.set('initial', history.get('initial'))))).toThrow('cannot be changed or deleted')
    const full = mutateHistory(base, history => {
      const initial = history.get('initial')
      for (let index = 1; index < MAX_NOTE_VERSIONS; index++) history.set(crypto.randomUUID(), initial)
    })
    expect(listNoteVersions(full)).toHaveLength(MAX_NOTE_VERSIONS)
    expect(() => checkpointNote(editNote(full, { content: 'At capacity' }))).toThrow('too many saved versions')
    expect(listNoteVersions(full)).toHaveLength(MAX_NOTE_VERSIONS)
    expect(() => validateCrdtNote(mutateHistory(full, history => history.set(crypto.randomUUID(), history.get('initial'))))).toThrow('too many saved versions')
  })
})
