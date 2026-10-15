import { describe, expect, it } from 'vitest'
import { folderMoveTarget, isEmptyFolder, planFolderRelocation } from './folder-operations'

function row(id: string, folder: string, deleted = false) { return { note: { id, folder, deleted } } }

describe('folder move planning', () => {
  it('moves a complete subtree while preserving other branches and the old parent', () => {
    const records = [row('one', 'Work/Ideas'), row('two', 'Work/Ideas/Drafts'), row('other', 'Workshop')]
    const before = structuredClone(records)
    const plan = planFolderRelocation(records, ['Personal', 'Work/Ideas/Empty'], 'Work/Ideas', folderMoveTarget('Work/Ideas', 'Personal'))
    expect(plan.target).toBe('Personal/Ideas')
    expect(plan.moves).toEqual([
      { id: 'one', from: 'Work/Ideas', to: 'Personal/Ideas' },
      { id: 'two', from: 'Work/Ideas/Drafts', to: 'Personal/Ideas/Drafts' },
    ])
    expect(plan.folders).toEqual(['Personal', 'Personal/Ideas', 'Personal/Ideas/Drafts', 'Personal/Ideas/Empty', 'Work', 'Workshop'])
    expect(plan.stagedFolders).toContain('Work/Ideas/Drafts')
    expect(plan.stagedFolders).toContain('Personal/Ideas/Drafts')
    expect(records).toEqual(before)
  })

  it('moves a nested folder to the root without dissolving the folder', () => {
    const target = folderMoveTarget('Work/Ideas', '')
    expect(target).toBe('Ideas')
    const plan = planFolderRelocation([row('one', 'Work/Ideas/Drafts')], [], 'Work/Ideas', target)
    expect(plan.moves[0].to).toBe('Ideas/Drafts')
    expect(plan.folders).toEqual(['Ideas', 'Ideas/Drafts', 'Work'])
  })

  it('treats similarly prefixed folder names as distinct branches', () => {
    expect(folderMoveTarget('Work', 'Workshop')).toBe('Workshop/Work')
    const plan = planFolderRelocation([row('one', 'Work'), row('other', 'Workshop')], [], 'Work', 'Workshop/Work')
    expect(plan.moves).toEqual([{ id: 'one', from: 'Work', to: 'Workshop/Work' }])
  })

  it.each(['Work', 'Work/Ideas'])('rejects dropping a folder onto itself or its descendant %s', parent => {
    expect(() => folderMoveTarget('Work', parent)).toThrow('itself or its subfolders')
  })

  it('rejects collisions, absent parents and no-op relocations before mutations', () => {
    const records = [row('one', 'Work')]
    expect(() => planFolderRelocation(records, ['Other'], 'Work', 'Other')).toThrow('already exists')
    expect(() => planFolderRelocation(records, [], 'Work', 'Missing/Work')).toThrow('destination folder')
    expect(() => planFolderRelocation(records, [], 'Missing', 'Other')).toThrow('source folder')
    expect(() => planFolderRelocation(records, [], 'Work', 'Work')).toThrow('already there')
    expect(() => planFolderRelocation(records, ['Work/Child'], 'Work', 'Work/Child/New')).toThrow('itself or its subfolders')
  })

  it('validates depth for all descendants, including notes in Trash', () => {
    const deep = 'Work/a/b/c/d/e/f/g'
    expect(() => planFolderRelocation([row('trashed', deep, true)], ['Work', 'Parent'], 'Work', 'Parent/Work')).toThrow('up to 8 levels')
    expect(() => planFolderRelocation([row('live', deep)], ['Parent'], 'Work', 'Parent/Work')).toThrow('up to 8 levels')
  })

  it('keeps Trash folder metadata in the relocation plan', () => {
    const plan = planFolderRelocation([row('trashed', 'Work/Old', true)], ['Work'], 'Work', 'Renamed')
    expect(plan.moves).toEqual([{ id: 'trashed', from: 'Work/Old', to: 'Renamed/Old' }])
    expect(plan.folders).toEqual(['Renamed'])
  })

  it('validates the temporary registry size before starting a move', () => {
    const folders = Array.from({ length: 2000 }, (_, index) => `Folder${index}`)
    expect(() => planFolderRelocation([], folders, 'Folder0', 'Renamed')).toThrow('at most 2,000')
  })

  it('allows a caller to resume only after explicit opt-in to its staged destination', () => {
    const records = [row('pending', 'Work/Ideas'), row('moved', 'Renamed')]
    expect(() => planFolderRelocation(records, [], 'Work', 'Renamed')).toThrow('already exists')
    const plan = planFolderRelocation(records, [], 'Work', 'Renamed', { resume: true })
    expect(plan.moves).toEqual([{ id: 'pending', from: 'Work/Ideas', to: 'Renamed/Ideas' }])
    expect(plan.folders).toEqual(['Renamed', 'Renamed/Ideas'])
  })

  it('rejects malformed metadata rather than producing arbitrary paths', () => {
    expect(() => folderMoveTarget('Work', '../secret')).toThrow()
    expect(() => folderMoveTarget('', 'Work')).toThrow('named folder')
    expect(() => planFolderRelocation([], ['Work'], 'Work', 'Bad\\name')).toThrow()
    expect(() => planFolderRelocation([], ['Work'], 'Work', '')).toThrow('named source and destination')
  })
})

describe('empty folder deletion', () => {
  it('allows only existing named folders without notes or child folders', () => {
    expect(isEmptyFolder('Empty', [], ['Empty'])).toBe(true)
    expect(isEmptyFolder('Missing', [], ['Empty'])).toBe(false)
    expect(isEmptyFolder('', [], ['Empty'])).toBe(false)
    expect(isEmptyFolder('Empty', [], ['Empty/Child'])).toBe(false)
    expect(isEmptyFolder('Empty', [row('one', 'Empty')], [])).toBe(false)
    expect(isEmptyFolder('Empty', [row('one', 'Empty/Child')], [])).toBe(false)
  })

  it('does not block an empty folder because of another branch or Trash', () => {
    expect(isEmptyFolder('Work', [row('other', 'Workshop'), row('trashed', 'Work/Old', true)], ['Work'])).toBe(true)
  })
})
