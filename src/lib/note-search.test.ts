import { describe, expect, it } from 'vitest'
import { highlightText, noteExcerpt, searchNotes, searchTokens } from './note-search'

const rows = [
  { note: { id: 'garden', title: 'Garden plans', content: 'Grow TOMATOES this summer.', folder: 'Personal/Outside' } },
  { note: { id: 'work', title: 'Project notes', content: 'Garden design and tomatoes.', folder: 'Work' } },
  { note: { id: 'read', title: 'Reading', content: 'A garden book.', folder: 'Books' } },
]

describe('whole-note literal search', () => {
  it('matches titles AND entire bodies across folders, including terms split between fields', () => {
    expect(searchNotes(rows, 'garden tomatoes').map(match => match.row.note.id)).toEqual(['garden', 'work'])
    expect(searchNotes(rows, '  TOMATOES \n SUMMER  ').map(match => match.row.note.id)).toEqual(['garden'])
    expect(searchNotes(rows, 'books')).toEqual([])
    expect(searchNotes(rows, 'gardens')).toEqual([])
    expect(searchNotes(rows, '').map(match => match.row)).toEqual(rows)
  })

  it('matches arbitrary punctuation as text and never treats a query as a regular expression', () => {
    const source = [{ note: { id: 'punctuation', title: 'HTTP [draft]', content: 'Use foo(bar) => x.* and C++ with <script>alert(1)</script>.' } }]
    for (const query of ['[draft]', 'foo(bar)', 'x.*', 'C++', '<script>alert(1)</script>']) expect(searchNotes(source, query)).toHaveLength(1)
    expect(searchNotes(source, '[.*]')).toEqual([])
    expect(searchTokens('one ONE one two')).toEqual(['one', 'two'])
  })

  it('does not silently drop explicitly supplied Trash records', () => {
    const deleted = { note: { id: 'trash', title: 'Removed', content: 'Recover this text.', deleted: true } }
    expect(searchNotes([deleted], 'recover')[0].row).toBe(deleted)
  })

  it('ranks exact and title matches before body-only matches while preserving source order on ties', () => {
    const candidates = [
      { note: { id: 'body', title: 'Other', content: 'Garden' } },
      { note: { id: 'partial', title: 'My garden notes', content: '' } },
      { note: { id: 'exact', title: 'Garden', content: '' } },
      { note: { id: 'body2', title: 'Another', content: 'Garden' } },
    ]
    expect(searchNotes(candidates, 'garden').map(match => match.row.note.id)).toEqual(['exact', 'partial', 'body', 'body2'])
  })

  it('finds body text far beyond its opening lines and returns a matching excerpt', () => {
    const text = `${'Unrelated opening. '.repeat(100)}The needle is deep in this note. ${'Unrelated ending. '.repeat(100)}`
    const [match] = searchNotes([{ note: { id: 'long', title: 'Ordinary title', content: text } }], 'needle')
    expect(match.bodyMatched).toBe(true)
    expect(match.excerptText).toContain('needle')
    expect(match.excerptText.length).toBeLessThanOrEqual(182)
    expect(match.excerpt.some(part => part.text === 'needle' && part.match)).toBe(true)
    expect(match.excerptText).not.toContain('Unrelated opening. Unrelated opening. Unrelated opening.')
  })

  it('prefers a body excerpt with more query terms over an earlier isolated hit', () => {
    const text = `apple ${'filler '.repeat(100)}orange apple together. ${'after '.repeat(100)}`
    const excerpt = noteExcerpt(text, 'apple orange')
    expect(excerpt).toContain('orange apple together')
  })

  it('keeps an end-of-note match near the start of its excerpt on narrow sidebars', () => {
    const excerpt = noteExcerpt(`${'Earlier material. '.repeat(150)}A final needle.`, 'needle')
    expect(excerpt).toContain('needle')
    expect(excerpt.indexOf('needle')).toBeLessThanOrEqual(30)
  })
})

describe('safe highlight segments', () => {
  it('preserves raw text, merges overlapping hits, and highlights every occurrence', () => {
    const text = '<script>banana & BANANA</script>'
    const parts = highlightText(text, 'banana ana')
    expect(parts.map(part => part.text).join('')).toBe(text)
    expect(parts.filter(part => part.match).map(part => part.text)).toEqual(['banana', 'BANANA'])
    expect(highlightText('', 'a')).toEqual([{ text: '', match: false }])
  })

  it('keeps original Unicode boundaries when case-folding expands a character', () => {
    const text = 'İSTANBUL 日本語 😀'
    const parts = highlightText(text, 'i 日本語 😀')
    expect(parts.map(part => part.text).join('')).toBe(text)
    expect(parts.filter(part => part.match).map(part => part.text)).toEqual(['İ', '日本語', '😀'])
    expect(highlightText('unmatched', '(')).toEqual([{ text: 'unmatched', match: false }])
  })
})
