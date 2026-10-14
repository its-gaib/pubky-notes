import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { editNote, encode, initializeNote, LineageConflictError, MAX_NOTE_BYTES, mergeNotes, noteRevision, prepareLocalNote, validateCrdtNote } from './crdt'
import type { CrdtNote } from './crdt'
import { createSharedNote, joinSharedNote, sharedNoteDescriptor, SharedNoteDocument } from './shared-note'

const source = (): CrdtNote => initializeNote({ id: 'original', title: 'Meeting', content: 'First line\nLast line', createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z', folder: 'Private/Work' })
const pair = () => {
  const alice = new SharedNoteDocument(createSharedNote(source()))
  const bob = new SharedNoteDocument(joinSharedNote(alice.descriptor, alice.getUpdate()))
  return { alice, bob }
}

function updateWith(mutate: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc({ gc: false })
  try { mutate(doc); return Y.encodeStateAsUpdate(doc) }
  finally { doc.destroy() }
}

describe('shared notes', () => {
  it('forks only visible title and content, retaining the original without sharing its private history', () => {
    const original = editNote(initializeNote({ ...source(), crdt: undefined, content: 'Never share this deleted secret' }), { content: 'Visible text' })
    const before = JSON.stringify(original)
    const shared = createSharedNote(original)
    expect(shared.id).not.toBe(original.id)
    expect(shared.title).toBe(original.title)
    expect(shared.content).toBe('Visible text')
    expect(shared.folder).toBe(original.folder)
    expect(JSON.stringify(original)).toBe(before)
    const bytes = Uint8Array.from(atob(shared.crdt!.update), char => char.charCodeAt(0))
    const binary = new TextDecoder().decode(bytes)
    expect(binary).not.toContain('Never share')
    expect(binary).not.toContain('Private/Work')
    expect(binary).not.toContain('meta')
    expect(joinSharedNote(sharedNoteDescriptor(shared), bytes).folder).toBeUndefined()
  })

  it('converges after concurrent edits, duplicate deliveries, disconnection, reload, and reversed delivery', () => {
    const { alice, bob } = pair()
    alice.edit({ content: 'First line Alice\nLast line' })
    bob.edit({ content: 'First line\nLast line Bob' })
    const a = alice.getUpdate(), b = bob.getUpdate()
    alice.applyPeerUpdate(b); bob.applyPeerUpdate(a)
    expect(alice.note.content).toBe('First line Alice\nLast line Bob')
    expect(bob.note.content).toBe(alice.note.content)
    expect(bob.note.crdt!.update).toBe(alice.note.crdt!.update)
    const revision = noteRevision(alice.note)
    alice.applyPeerUpdate(b); alice.applyPeerUpdate(a)
    expect(noteRevision(alice.note)).toBe(revision)
    const reopened = new SharedNoteDocument(JSON.parse(JSON.stringify(alice.note)))
    reopened.edit({ title: 'Reopened title' })
    bob.edit({ content: `${bob.note.content}\nOffline addition` })
    const ra = reopened.getUpdate(bob.getStateVector()), rb = bob.getUpdate(reopened.getStateVector())
    reopened.applyPeerUpdate(rb); bob.applyPeerUpdate(ra)
    expect(bob.note).toMatchObject({ title: 'Reopened title', content: 'First line Alice\nLast line Bob\nOffline addition' })
    expect(bob.note.crdt!.update).toBe(reopened.note.crdt!.update)
    alice.destroy(); bob.destroy(); reopened.destroy()
  })

  it('preserves independent folders and Trash while continuing to exchange text', () => {
    const { alice, bob } = pair()
    const sharedBefore = alice.note.crdt!.update
    const revisionBefore = noteRevision(alice.note)
    alice.edit({ folder: 'Alice/Personal', deleted: true })
    bob.edit({ folder: 'Bob/Work', content: 'A useful edit' })
    expect(alice.note.crdt!.update).toBe(sharedBefore)
    expect(noteRevision(alice.note)).not.toBe(revisionBefore)
    bob.applyPeerUpdate(alice.getUpdate())
    alice.applyPeerUpdate(bob.getUpdate())
    expect(alice.note).toMatchObject({ folder: 'Alice/Personal', deleted: true, content: 'A useful edit' })
    expect(bob.note.folder).toBe('Bob/Work')
    expect(bob.note.deleted).toBeUndefined()
    alice.destroy(); bob.destroy()
  })

  it('merges both state documents only for copies from the same account', async () => {
    const shared = createSharedNote(source())
    const laptop = editNote(shared, { folder: 'Changed folder', deleted: true })
    const phone = editNote(shared, { content: 'Changed on phone' })
    const merged = mergeNotes(laptop, phone)
    expect(merged).toMatchObject({ folder: 'Changed folder', deleted: true, content: 'Changed on phone' })
    expect(mergeNotes(phone, laptop)).toEqual(merged)
    const live = new SharedNoteDocument(phone)
    expect(live.mergeLocal(laptop)).toEqual(merged)
    expect(validateCrdtNote(merged)).toEqual(merged)
    const fromOldUi = await prepareLocalNote({ ...merged, content: 'Snapshot UI edit' })
    expect(fromOldUi).toMatchObject({ content: 'Snapshot UI edit', deleted: true, folder: 'Changed folder' })
    expect(validateCrdtNote(fromOldUi)).toEqual(fromOldUi)
    live.destroy()
  })

  it('refuses ordinary notes, forged snapshots, and unrelated shared histories', () => {
    const shared = createSharedNote(source())
    expect(() => new SharedNoteDocument(source())).toThrow('not a shared')
    expect(() => mergeNotes(shared, { ...source(), id: shared.id, createdAt: shared.createdAt })).toThrow(LineageConflictError)
    expect(() => mergeNotes(shared, { ...createSharedNote(source()), id: shared.id, createdAt: shared.createdAt })).toThrow(LineageConflictError)
    expect(() => validateCrdtNote({ ...shared, content: 'Forged' })).toThrow('does not match')
    expect(() => validateCrdtNote({ ...shared, folder: 'Forged' })).toThrow('does not match')
    expect(() => joinSharedNote({ ...sharedNoteDescriptor(shared), id: '../outside' }, new SharedNoteDocument(shared).getUpdate())).toThrow('Invalid note data')
  })

  it.each([
    ['metadata', (doc: Y.Doc): void => { doc.getMap('meta').set('deleted', true) }],
    ['unexpected root', (doc: Y.Doc) => doc.getText('private').insert(0, 'secret')],
    ['formatting', (doc: Y.Doc) => doc.getText('content').insert(0, 'bold', { bold: true })],
    ['embedded object', (doc: Y.Doc) => doc.getText('content').insertEmbed(0, { attack: true })],
    ['array', (doc: Y.Doc) => doc.getArray('content').insert(0, ['bad'])],
    ['nested type', (doc: Y.Doc) => doc.getMap('content').set('nested', new Y.Text('bad'))],
    ['deleted hidden metadata', (doc: Y.Doc) => { doc.getMap('meta').set('secret', 'hidden'); doc.getMap('meta').delete('secret') }],
  ] as const)('rejects %s before poisoning the live document', (_label, mutate) => {
    const { alice, bob } = pair()
    const before = alice.note
    expect(() => alice.applyPeerUpdate(updateWith(mutate))).toThrow()
    expect(alice.note).toEqual(before)
    bob.edit({ content: 'Healthy future update' })
    alice.applyPeerUpdate(bob.getUpdate())
    expect(alice.note.content).toBe('Healthy future update')
    alice.destroy(); bob.destroy()
  })

  it('rejects malformed, oversized, and over-limit text without poisoning state', () => {
    const { alice } = pair()
    const before = alice.note
    for (const bytes of [new Uint8Array([255]), new Uint8Array(MAX_NOTE_BYTES + 1), updateWith(doc => doc.getText('title').insert(0, 'x'.repeat(201)))]) {
      expect(() => alice.applyPeerUpdate(bytes)).toThrow()
      expect(alice.note).toEqual(before)
    }
    expect(() => alice.edit({ content: 'x'.repeat(250_001) })).toThrow()
    expect(alice.note).toEqual(before)
    alice.edit({ content: 'Still editable' })
    expect(alice.note.content).toBe('Still editable')
    alice.destroy()
  })

  it('retains out-of-order causal updates until the missing predecessor arrives', () => {
    const { alice, bob } = pair()
    const vector = alice.getStateVector()
    alice.edit({ content: 'First line\nLast line 1' })
    const first = alice.getUpdate(vector), secondVector = alice.getStateVector()
    alice.edit({ content: 'First line\nLast line 12' })
    const second = alice.getUpdate(secondVector)
    bob.applyPeerUpdate(second)
    const reopened = new SharedNoteDocument(bob.note)
    reopened.applyPeerUpdate(first)
    expect(reopened.note.content).toBe(alice.note.content)
    expect(reopened.note.crdt!.update).toBe(alice.note.crdt!.update)
    expect(() => joinSharedNote(alice.descriptor, second)).toThrow('incomplete')
    alice.destroy(); bob.destroy(); reopened.destroy()
  })

  it('preserves cursor positions relative to concurrent text inserts', () => {
    const { alice, bob } = pair()
    const cursor = alice.captureSelection('content', 6, 10)
    bob.edit({ content: `Prefix ${bob.note.content}` })
    alice.applyPeerUpdate(bob.getUpdate())
    expect(alice.resolveSelection(cursor)).toEqual({ start: 13, end: 17 })
    alice.destroy(); bob.destroy()
  })

  it('does not leak writable note state and stops after destruction', () => {
    const { alice } = pair()
    const returned = alice.note
    returned.content = 'Mutated'
    returned.crdt!.update = encode(new Uint8Array([0, 0]))
    expect(alice.note.content).toBe('First line\nLast line')
    alice.destroy(); alice.destroy()
    expect(() => alice.getUpdate()).toThrow('closed')
    expect(() => alice.edit({ title: 'Closed' })).toThrow('closed')
  })
})
