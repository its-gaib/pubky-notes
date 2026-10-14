import { describe, expect, it } from 'vitest'
import { filterNotes, folderContains, folderLabel, folderPaths, normalizeFolder, renameFolderPath } from './folders'

describe('folder metadata', () => {
  it('normalizes path and segment whitespace while retaining readable names', () => {
    expect(normalizeFolder(' / Work / Reading list / ')).toBe('Work/Reading list')
    expect(normalizeFolder('')).toBe('')
    expect(normalizeFolder(' / ')).toBe('')
    expect(normalizeFolder('Ideas/日本語')).toBe('Ideas/日本語')
  })

  it.each(['Work//Ideas', 'Work/ /Ideas', '.', '..', 'Work/../Ideas', 'Work/./Ideas', 'Work\\Ideas',
    'Work\nIdeas', 'Work\t', '\u0000Ideas', 'Work\u007f', 'Work\u0085'])('rejects invalid folder %j', (input) => {
    expect(() => normalizeFolder(input)).toThrow()
  })

  it('enforces depth, segment, and total limits', () => {
    expect(normalizeFolder(Array(8).fill('x').join('/'))).toHaveLength(15)
    expect(() => normalizeFolder(Array(9).fill('x').join('/'))).toThrow()
    expect(normalizeFolder('x'.repeat(80))).toHaveLength(80)
    expect(() => normalizeFolder('x'.repeat(81))).toThrow()
    expect(() => normalizeFolder(Array(7).fill('x'.repeat(80)).join('/'))).toThrow()
    expect(normalizeFolder(`${Array(6).fill('x'.repeat(80)).join('/')}/${'x'.repeat(26)}`)).toHaveLength(512)
  })

  it('includes each parent once and omits unfiled notes from the folder tree', () => {
    expect(folderPaths([
      { note: { folder: 'Work/Research/Books' } }, { note: { folder: 'Personal' } },
      { note: { folder: 'Work/Research' } }, { note: {} }, { note: { folder: '' } },
    ])).toEqual(['Personal', 'Work', 'Work/Research', 'Work/Research/Books'])
    expect(folderLabel('Work/Research/Books')).toBe('Books')
    expect(folderLabel('')).toBe('')
  })

  it('matches descendants at segment boundaries and treats root as unfiled', () => {
    expect(folderContains('Work', 'Work')).toBe(true)
    expect(folderContains('Work', 'Work/Research')).toBe(true)
    expect(folderContains('Work', 'Workshop')).toBe(false)
    expect(folderContains('Work', 'Personal/Work')).toBe(false)
    expect(folderContains('', '')).toBe(true)
    expect(folderContains('', 'Work')).toBe(false)
  })

  it('rewrites only a matching subtree and supports moving it to root', () => {
    expect(renameFolderPath('Work/Research/Books', 'Work/Research', 'Personal/Reading')).toBe('Personal/Reading/Books')
    expect(renameFolderPath('Work', 'Work', '')).toBe('')
    expect(renameFolderPath('Work/Books', 'Work', '')).toBe('Books')
    expect(renameFolderPath('Workshop/Books', 'Work', 'Home')).toBe('Workshop/Books')
    expect(() => renameFolderPath('Work', '', 'Home')).toThrow()
    expect(() => renameFolderPath('Work/Books', 'Work', Array(8).fill('x').join('/'))).toThrow()
  })
})

describe('global note search', () => {
  const records = [
    { note: { title: 'Garden plans', content: 'Grow tomatoes this summer.', folder: 'Personal/Outside' }, published: null },
    { note: { title: 'Project notes', content: 'GARDEN design and tomatoes.', folder: 'Work' }, published: {} },
    { note: { title: 'Reading', content: 'A garden book.', folder: 'Garden' }, published: null },
    { note: { title: 'Shopping', content: 'Seeds and tools.' }, published: null },
  ]

  it('searches all titles and contents with every token, ignoring active folder and visibility filters', () => {
    expect(filterNotes(records, '  GARDEN \n tomatoes  ', 'private', 'Personal')).toEqual(records.slice(0, 2))
    expect(filterNotes(records, 'garden', 'public', '')).toEqual(records.slice(0, 3))
    expect(filterNotes(records, 'Personal', 'all', null)).toEqual([])
    expect(filterNotes(records, 'garden seeds', 'all', null)).toEqual([])
  })

  it('applies visibility and folder filters only when the query is blank', () => {
    expect(filterNotes(records, ' \n ', 'private', 'Personal')).toEqual([records[0]])
    expect(filterNotes(records, '', 'public', null)).toEqual([records[1]])
    expect(filterNotes(records, '', 'private', '')).toEqual([records[3]])
    expect(filterNotes(records, '', 'all', null)).toEqual(records)
    expect(filterNotes(records, '', 'public', 'Personal')).toEqual([])
  })
})
