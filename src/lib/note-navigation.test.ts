// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_RECENT_NOTES, readNoteNavigation, rememberNote, sortNavigableNotes, toggleNotePin, writeNoteNavigation } from './note-navigation'

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })
const empty = { pinned: [], recent: [] }
const rows = [
  { note: { id: 'old', title: 'A title', content: '', updatedAt: '2026-01-01T00:00:00Z' } },
  { note: { id: 'new', title: 'Z title', content: '', updatedAt: '2026-02-01T00:00:00Z' } },
  { note: { id: 'deleted', title: 'Removed', content: '', deleted: true } },
]

describe('notebook navigation preferences', () => {
  it('keeps pins and recents isolated by account and network, with no note text', () => {
    const preferences = rememberNote(toggleNotePin(empty, 'old'), 'new')
    expect(writeNoteNavigation('mainnet:alice', preferences)).toBe(true)
    expect(readNoteNavigation('mainnet:alice')).toEqual({ pinned: ['old'], recent: ['new'] })
    expect(readNoteNavigation('mainnet:bob')).toEqual(empty)
    expect(readNoteNavigation('testnet:alice')).toEqual(empty)
    expect(readNoteNavigation('mainnet:guest')).toEqual(empty)
    const persisted = localStorage.getItem('pubky-notes:navigation:mainnet:alice')!
    expect(JSON.parse(persisted)).toEqual({ version: 1, ...preferences })
    expect(persisted).not.toContain('title')
    expect(persisted).not.toContain('content')
  })

  it('bounds and deduplicates recent identifiers and toggles pins independently', () => {
    let preferences = { pinned: ['old'], recent: [] as string[] }
    for (let index = 0; index < 300; index++) preferences = rememberNote(preferences, `note-${index}`)
    expect(preferences.recent).toHaveLength(MAX_RECENT_NOTES)
    expect(rememberNote(preferences, 'note-299').recent).toHaveLength(MAX_RECENT_NOTES)
    expect(toggleNotePin(preferences, 'old').pinned).toEqual([])
    expect(toggleNotePin(preferences, 'new').pinned).toEqual(['new', 'old'])
    expect(rememberNote(preferences, '../invalid')).toEqual(preferences)
  })

  it('sanitizes malformed or oversized stored values and handles storage denial', () => {
    const key = 'pubky-notes:navigation:mainnet:alice'
    localStorage.setItem(key, JSON.stringify({ version: 1, pinned: ['old', 'old', '../bad', 42], recent: ['new'], title: 'private text' }))
    expect(readNoteNavigation('mainnet:alice')).toEqual({ pinned: ['old'], recent: ['new'] })
    localStorage.setItem(key, '{broken')
    expect(readNoteNavigation('mainnet:alice')).toEqual(empty)
    localStorage.setItem(key, 'x'.repeat(200_001))
    expect(readNoteNavigation('mainnet:alice')).toEqual(empty)
    expect(writeNoteNavigation('../invalid', empty)).toBe(false)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(writeNoteNavigation('mainnet:alice', empty)).toBe(false)
  })

  it('places pinned notes first, then recently opened notes, then recently modified notes', () => {
    expect(sortNavigableNotes(rows, empty).map(row => row.note.id)).toEqual(['new', 'old'])
    expect(sortNavigableNotes(rows, { pinned: [], recent: ['old'] }).map(row => row.note.id)).toEqual(['old', 'new'])
    expect(sortNavigableNotes(rows, { pinned: ['old'], recent: ['new'] }).map(row => row.note.id)).toEqual(['old', 'new'])
    expect(sortNavigableNotes(rows, empty, 'title').map(row => row.note.id)).toEqual(['old', 'new'])
    expect(sortNavigableNotes(rows, { pinned: ['new', 'missing'], recent: [] }, 'title').map(row => row.note.id)).toEqual(['new', 'old'])
    expect(rows).toHaveLength(3)
  })
})
