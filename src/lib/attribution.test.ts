import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { checkpointNote, decode, editNote, encode, initializeNote, listNoteVersions, mergeNotes, readNoteVersion, readNoteVersionChanges, validateCrdtNote } from './crdt'
import type { CrdtNote } from './crdt'
import { createSharedNote, joinSharedNote, SharedNoteDocument } from './shared-note'

const alice = { id: 'editor:alice', label: 'Alice' }
const bob = { id: 'editor:bob', label: 'Bob' }
const date = '2026-10-15T10:00:00.000Z'
const source = (content = 'First line\nLast line'): CrdtNote => initializeNote({ id: 'attributed-note', title: 'Title', content, createdAt: date, updatedAt: date, folder: 'Private' })
const latest = (note: CrdtNote) => listNoteVersions(note).at(-1)!.id

function mutate(note: CrdtNote, change: (doc: Y.Doc) => void): CrdtNote {
  const doc = new Y.Doc({ gc: false })
  try {
    Y.applyUpdate(doc, decode(note.crdt!.update))
    change(doc)
    return { ...note, crdt: { ...note.crdt!, update: encode(Y.encodeStateAsUpdate(doc)) } }
  } finally { doc.destroy() }
}

describe('reported edit attribution', () => {
  it('retains exactly who inserted and deleted text, including adjacent coalesced deletions and restores', () => {
    const initial = source('abcd')
    const one = checkpointNote(editNote(initial, { content: 'cd' }, alice))
    const two = checkpointNote(editNote(one, { content: '' }, bob))
    expect(readNoteVersionChanges(two, 'initial')).toEqual({ baseline: true, edits: [] })
    expect(readNoteVersionChanges(two, latest(one)).edits).toEqual([expect.objectContaining({ author: alice, changes: [{ field: 'content', inserted: '', deleted: 'ab' }] })])
    expect(readNoteVersionChanges(two, latest(two)).edits).toEqual([expect.objectContaining({ author: bob, changes: [{ field: 'content', inserted: '', deleted: 'cd' }] })])
    const restored = checkpointNote(editNote(two, readNoteVersion(two, 'initial'), alice), { restoredFrom: 'initial' })
    expect(readNoteVersionChanges(restored, latest(restored)).edits).toEqual([expect.objectContaining({ author: alice, changes: [{ field: 'content', inserted: 'abcd', deleted: '' }] })])
    expect(listNoteVersions(restored)).toHaveLength(4)
  })

  it('keeps deletion text in document order even when characters came from different clients', () => {
    const middle = editNote(source('ac'), { content: 'abc' }, alice)
    const before = checkpointNote(middle)
    const removed = checkpointNote(editNote(before, { content: '' }, bob))
    expect(readNoteVersionChanges(removed, latest(removed)).edits[0]?.changes).toEqual([{ field: 'content', inserted: '', deleted: 'abc' }])
  })

  it('shows both contributors in one checkpoint after concurrent insertion and deletion', () => {
    const a = new SharedNoteDocument(createSharedNote(source()))
    const b = new SharedNoteDocument(joinSharedNote(a.descriptor, a.getUpdate()))
    try {
      a.edit({ content: '\nLast line' }, alice)
      b.edit({ content: 'First line\nLast line Bob' }, bob)
      const aUpdate = a.getUpdate(), bUpdate = b.getUpdate()
      a.applyPeerUpdate(bUpdate); b.applyPeerUpdate(aUpdate)
      expect(a.note.content).toBe('\nLast line Bob')
      expect(b.note.crdt!.update).toBe(a.note.crdt!.update)
      const saved = checkpointNote(a.note)
      const changes = readNoteVersionChanges(saved, latest(saved))
      expect(changes.edits).toHaveLength(2)
      expect(changes.edits).toEqual(expect.arrayContaining([
        expect.objectContaining({ author: alice, changes: [{ field: 'content', inserted: '', deleted: 'First line' }] }),
        expect.objectContaining({ author: bob, changes: [{ field: 'content', inserted: ' Bob', deleted: '' }] }),
      ]))
      expect(readNoteVersionChanges(JSON.parse(JSON.stringify(saved)), latest(saved))).toEqual(changes)
    } finally { a.destroy(); b.destroy() }
  })

  it('preserves offline authors without inventing deletions or repeating contributions when branches reunite', () => {
    const base = createSharedNote(source())
    const left = checkpointNote(editNote(base, { content: 'First line Alice\nLast line' }, alice), { recordedAt: '2026-10-16T10:00:00.000Z' })
    const right = checkpointNote(editNote(base, { content: 'First line\nLast line Bob' }, bob), { recordedAt: '2026-10-16T10:01:00.000Z' })
    const merged = checkpointNote(mergeNotes(left, right), { recordedAt: '2026-10-16T10:02:00.000Z' })
    expect(readNoteVersionChanges(merged, latest(left)).edits).toEqual([expect.objectContaining({ author: alice, changes: [{ field: 'content', inserted: ' Alice', deleted: '' }] })])
    expect(readNoteVersionChanges(merged, latest(right)).edits).toEqual([expect.objectContaining({ author: bob, changes: [{ field: 'content', inserted: ' Bob', deleted: '' }] })])
    expect(readNoteVersionChanges(merged, latest(merged))).toEqual({ baseline: false, edits: [] })
    expect(mergeNotes(right, left).crdt!.update).toBe(mergeNotes(left, right).crdt!.update)
  })

  it('keeps private attribution out of a shared copy and starts late joiners at their observed baseline', () => {
    const privateAuthor = { id: 'private:editor', label: 'Private editor name' }
    const original = checkpointNote(editNote(source('Private secret'), { content: 'Visible text' }, privateAuthor))
    const shared = createSharedNote(original)
    const a = new SharedNoteDocument(shared)
    try {
      expect(new TextDecoder().decode(a.getUpdate())).not.toContain(privateAuthor.label)
      expect(new TextDecoder().decode(a.getUpdate())).not.toContain('Private secret')
      a.edit({ content: 'Visible text Alice' }, alice)
      const joined = joinSharedNote(a.descriptor, a.getUpdate())
      expect(readNoteVersionChanges(joined, latest(joined))).toEqual({ baseline: true, edits: [] })
      const b = new SharedNoteDocument(joined)
      try {
        a.edit({ title: 'A new title' }, alice)
        b.applyPeerUpdate(a.getUpdate())
        const saved = checkpointNote(b.note)
        expect(readNoteVersionChanges(saved, latest(saved)).edits).toEqual([expect.objectContaining({ author: alice, changes: [{ field: 'title', inserted: 'A new t', deleted: 'T' }] })])
      } finally { b.destroy() }
    } finally { a.destroy() }
  })

  it('leaves edits without supplied identity unattributed and ignores personal metadata changes', () => {
    const base = createSharedNote(source())
    const changed = checkpointNote(editNote(base, { content: 'Changed' }))
    expect(readNoteVersionChanges(changed, latest(changed)).edits[0]).not.toHaveProperty('author')
    const moved = editNote(changed, { folder: 'Elsewhere', deleted: true }, alice)
    expect(moved.crdt!.update).toBe(changed.crdt!.update)
    expect(readNoteVersionChanges(moved, latest(changed))).toEqual(readNoteVersionChanges(changed, latest(changed)))
  })

  it('rejects invalid identities, unavailable or non-text ranges, and rewritten attribution', () => {
    const changed = editNote(createSharedNote(source()), { content: 'Changed' }, alice)
    expect(() => editNote(changed, { content: 'Rejected' }, { id: 'bad id', label: 'Bad' })).toThrow('editor attribution')
    const sanitized = checkpointNote(editNote(changed, { content: 'Sanitized' }, { id: 'safe', label: ` \u202e${'😀'.repeat(90)} ` }))
    expect(readNoteVersionChanges(sanitized, latest(sanitized)).edits.find(edit => edit.author?.id === 'safe')?.author).toEqual({ id: 'safe', label: '😀'.repeat(64) })
    for (const range of [
      { field: 'content', client: 0xffffffff, clock: 0, length: 1 },
      { field: 'content', client: 0, clock: 0, length: 250_001 },
      { field: 'meta', client: 0, clock: 0, length: 1 },
      { field: 'content', client: 0, clock: -1, length: 1 },
    ]) {
      const invalid = mutate(changed, doc => doc.getMap('edits').set(crypto.randomUUID(), { recordedAt: date, author: alice, inserted: [], deleted: [range] }))
      expect(() => validateCrdtNote(invalid)).toThrow()
    }
    const wrongOwnership = mutate(changed, doc => doc.getMap('edits').set(crypto.randomUUID(), { recordedAt: date, inserted: [{ field: 'title', client: 0, clock: 0, length: 1 }], deleted: [] }))
    expect(() => validateCrdtNote(wrongOwnership)).toThrow('insertion ownership')
    for (const replace of [false, true]) {
      const invalid = mutate(changed, doc => {
        const edits = doc.getMap('edits'), id = [...edits.keys()][0]!
        if (replace) edits.set(id, edits.get(id)); else edits.delete(id)
      })
      expect(() => validateCrdtNote(invalid)).toThrow()
    }
    const privateNote = editNote(source(), { content: 'Changed' }, alice)
    const hidden = mutate(privateNote, doc => doc.getMap('edits').set(crypto.randomUUID(), { recordedAt: date, inserted: [], deleted: [{ field: 'content', client: 0, clock: 0, length: 1 }] }))
    expect(() => validateCrdtNote(hidden)).toThrow('unavailable text')
  })

  it('rejects malicious attribution without poisoning a live shared document', () => {
    const a = new SharedNoteDocument(createSharedNote(source()))
    try {
      a.edit({ content: 'Healthy' }, alice)
      const before = a.note
      const invalid = mutate(before, doc => doc.getMap('edits').set(crypto.randomUUID(), { recordedAt: date, author: alice, inserted: [], deleted: [{ field: 'content', client: 0xffffffff, clock: 0, length: 1 }] }))
      expect(() => a.applyPeerUpdate(decode(invalid.crdt!.update))).toThrow()
      expect(a.note).toEqual(before)
      a.edit({ content: 'Still healthy' }, bob)
      expect(a.note.content).toBe('Still healthy')
    } finally { a.destroy() }
  })

  it('rejects repeated and overlapping ranges and deletion claims about still-visible text', () => {
    const base = createSharedNote(source('abc'))
    const deleted = editNote(base, { content: '' }, alice)
    for (const overlap of [false, true]) {
      const invalid = mutate(deleted, doc => {
        const journal = doc.getMap<{ recordedAt: string; deleted: Array<Record<string, unknown>> }>('edits')
        const entry = [...journal.values()][0]!, range = entry.deleted[0]!
        journal.set(crypto.randomUUID(), { ...entry, deleted: [range, overlap ? { ...range, clock: Number(range.clock) + 1, length: 1 } : range] })
      })
      expect(() => validateCrdtNote(invalid)).toThrow('overlap')
    }
    const visible = mutate(base, doc => doc.getMap('edits').set(crypto.randomUUID(), {
      recordedAt: date, inserted: [], deleted: [{ field: 'content', client: 0, clock: base.title.length, length: 1 }],
    }))
    expect(() => validateCrdtNote(visible)).toThrow('unavailable text')
  })

  it('bounds aggregate output across separate records before expanding referenced text', () => {
    const base = createSharedNote(source('x'.repeat(50_000)))
    const deleted = editNote(base, { content: '' }, alice)
    const repeated = (count: number) => mutate(deleted, doc => {
      const journal = doc.getMap('edits'), entry = [...journal.values()][0]!
      for (let index = 0; index < count; index++) journal.set(crypto.randomUUID(), entry)
    })
    const bounded = checkpointNote(validateCrdtNote(repeated(22)))
    expect(() => readNoteVersionChanges(bounded, latest(bounded))).toThrow('too many changes to display')
    expect(readNoteVersion(bounded, latest(bounded))).toEqual({ title: 'Title', content: '' })
    expect(() => validateCrdtNote(repeated(85))).toThrow('attribution is too large')
  })
})
