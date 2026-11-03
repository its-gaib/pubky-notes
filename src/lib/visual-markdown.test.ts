import { describe, expect, it } from 'vitest'
import { paragraphInsertion, renderedOffsets } from './visual-markdown'

describe('rendered Markdown boundaries', () => {
  it('keeps entity and escaped punctuation tokens whole in the middle of text', () => {
    expect(renderedOffsets('A &amp; B', 'A & B')).toEqual([0, 1, 2, 7, 8, 9])
    expect(renderedOffsets('A \\* B', 'A * B')).toEqual([0, 1, 2, 4, 5, 6])
    expect(renderedOffsets('&copy; Hi', '© Hi')).toEqual([0, 6, 7, 8, 9])
  })
  it('continues lists and quotes and separates ordinary paragraphs', () => {
    expect(paragraphInsertion('One', 3)).toBe('\n\n')
    expect(paragraphInsertion('- [x] Done', 10)).toBe('\n- [ ] ')
    expect(paragraphInsertion('8. Item', 7)).toBe('\n9. ')
    expect(paragraphInsertion('> Quote', 7)).toBe('\n> ')
  })
})
