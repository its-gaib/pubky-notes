import { describe, expect, it } from 'vitest'
import {
  editNote, ensureCrdt, initializeNote, LineageConflictError, MAX_NOTE_BYTES, mergeNotes,
  noteRevision, prepareLocalNote, validateCrdtNote,
} from './crdt'
import type { CrdtNote } from './crdt'

const fixture = (): CrdtNote => ({ id: 'note-1', title: 'A note', content: 'First line\nLast line', createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z' })

describe('note CRDT', () => {
  it('merges independent text changes in either order without dropping either edit', () => {
    const base = initializeNote(fixture())
    const left = editNote(base, { content: 'First line changed\nLast line' })
    const right = editNote(base, { content: 'First line\nLast line changed' })
    const merged = mergeNotes(left, right)
    expect(merged.content).toBe('First line changed\nLast line changed')
    expect(mergeNotes(right, left)).toEqual(merged)
    expect(mergeNotes(merged, left)).toEqual(merged)
    expect(mergeNotes(merged, merged)).toEqual(merged)
  })

  it('retains concurrent insertions at the same position and converges for overlapping changes', () => {
    const base = initializeNote({ ...fixture(), content: 'Hello' })
    const left = editNote(base, { content: 'Hello from laptop' })
    const right = editNote(base, { content: 'Hello from phone' })
    const a = mergeNotes(left, right), b = mergeNotes(right, left)
    expect(a).toEqual(b)
    expect(a.content).toContain(' from laptop')
    expect(a.content).toContain(' from phone')
  })

  it('creates incremental operations against the local base, preserving remote changes on later edits', () => {
    const base = initializeNote(fixture())
    const local = editNote(editNote(base, { content: 'First line local\nLast line' }), { content: 'First line local!\nLast line' })
    const remote = editNote(base, { content: 'First line\nLast line remote' })
    expect(mergeNotes(local, remote).content).toBe('First line local!\nLast line remote')
  })

  it('uses a deterministic immutable baseline for identical legacy snapshots', async () => {
    const a = await ensureCrdt(fixture()), b = await ensureCrdt(fixture())
    expect(a).toEqual(b)
    expect(a.crdt?.lineage).toMatch(/^legacy:[a-f0-9]{64}$/)
    expect(mergeNotes(editNote(a, { title: 'New title' }), editNote(b, { content: 'Updated body' }))).toMatchObject({ title: 'New title', content: 'Updated body' })
  })

  it('refuses to merge unrelated histories or independently changed legacy snapshots', async () => {
    expect(() => mergeNotes(initializeNote(fixture()), initializeNote(fixture()))).toThrow(LineageConflictError)
    const a = await ensureCrdt(fixture()), b = await ensureCrdt({ ...fixture(), content: 'Different legacy text' })
    expect(() => mergeNotes(a, b)).toThrow(LineageConflictError)
  })

  it('retains concurrent edits underneath a tombstone and restores only explicitly', () => {
    const base = initializeNote(fixture())
    const deleted = editNote(base, { deleted: true })
    const remoteEdit = editNote(base, { content: 'Saved while offline' })
    const merged = mergeNotes(deleted, remoteEdit)
    expect(merged).toMatchObject({ deleted: true, content: 'Saved while offline' })
    expect(editNote(merged, { title: 'A title change' }).deleted).toBe(true)
    expect(editNote(merged, { deleted: false }).deleted).toBeUndefined()
  })

  it('merges metadata separately from note text and validates nested folders', () => {
    const base = initializeNote(fixture())
    expect(mergeNotes(editNote(base, { folder: ' Work / Ideas ' }), editNote(base, { content: 'Changed body' }))).toMatchObject({ folder: 'Work/Ideas', content: 'Changed body' })
    expect(() => editNote(base, { folder: 'Work/../Secret' })).toThrow()
  })

  it('rejects snapshot tampering and malformed or oversized histories', () => {
    const base = initializeNote(fixture())
    expect(() => validateCrdtNote({ ...base, content: 'Tampered' })).toThrow('does not match')
    expect(() => validateCrdtNote({ ...base, crdt: null } as unknown as CrdtNote)).toThrow('Invalid note editing history')
    expect(() => validateCrdtNote({ ...base, crdt: { ...base.crdt!, update: 'AAAA' } })).toThrow()
    expect(() => validateCrdtNote({ ...base, crdt: { ...base.crdt!, update: 'A'.repeat(MAX_NOTE_BYTES + 4) } })).toThrow('oversized')
    expect(() => editNote(base, { content: 'x'.repeat(250_001) })).toThrow()
  })

  it('converts only trusted local snapshot edits into operations before saving', async () => {
    const base = initializeNote(fixture())
    const changed = await prepareLocalNote({ ...base, content: 'Edited by old UI' })
    expect(changed.content).toBe('Edited by old UI')
    expect(validateCrdtNote(changed)).toEqual(changed)
    expect(noteRevision(changed)).not.toBe(noteRevision(base))
  })

  it('handles large permitted Markdown and retains deleted text in private history only', () => {
    const base = initializeNote({ ...fixture(), content: 'x'.repeat(250_000) })
    const edited = editNote(base, { content: 'short' })
    expect(validateCrdtNote(edited).content).toBe('short')
    expect(edited.crdt!.update.length).toBeGreaterThan(250_000)
  })
})
