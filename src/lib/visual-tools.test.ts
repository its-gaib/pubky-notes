import { describe, expect, it } from 'vitest'
import { changeTable, linkMarkdown, safeLinkUrl } from './visual-tools'
import type { TableModel } from './visual-tools'

describe('Visual link URLs', () => {
  it('allows safe destinations and serializes parentheses/labels without raw HTML', () => {
    expect(linkMarkdown('<b>[text]</b>', 'https://example.com/a(b)')).toBe('[\\<b\\>\\[text\\]\\</b\\>](<https://example.com/a(b)>)')
    expect(safeLinkUrl('/pubkyowner/priv/notes/id.json')).toBe('/pubkyowner/priv/notes/id.json')
    expect(safeLinkUrl('mailto:a@example.com')).toBe('mailto:a@example.com')
  })
  for (const value of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '//evil.example/', '/\\evil.example/', 'jav&#x61;script:alert(1)']) {
    it(`rejects ${JSON.stringify(value)}`, () => expect(() => safeLinkUrl(value)).toThrow())
  }
})
describe('bounded source-preserving table edits', () => {
  const model: TableModel = { start: 0, end: 0, rows: [['A', 'B'], ['one', 'two']], align: ['left', 'right'], row: 1, column: 0, prefix: '> ', newline: '\n' }
  it('retains quote prefixes and alignment while adding a row', () => {
    const result = changeTable(model, 'row-after')
    expect(result.text).toBe('| A | B |\n> | :--- | ---: |\n> | one | two |\n> |  |  |')
    expect(result.text.slice(result.start, result.end)).toBe('')
  })
  it('deletes a final column as a complete table and refuses oversized growth', () => {
    expect(changeTable({ ...model, rows: [['A'], ['one']], column: 0 }, 'delete-column').text).toBe('')
    expect(() => changeTable({ ...model, rows: Array.from({ length: 20 }, () => ['A', 'B']) }, 'row-after')).toThrow('20')
  })
})
