// @vitest-environment jsdom
import { createRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import VisualEditor from './VisualEditor'
import type { VisualEditorHandle } from './VisualEditor'

afterEach(cleanup)
function Editor({ source, disabled = false }: { source: string; disabled?: boolean }) {
  const [content, setContent] = useState(source)
  return <><VisualEditor content={content} disabled={disabled} onChange={value => { setContent(value); return true }} /><output data-testid="source">{content}</output></>
}
function select(text: string, start: number, end = start) {
  const leaf = [...document.querySelectorAll<HTMLElement>('[data-source-start]')].find(node => node.textContent === text)!
  const range = document.createRange(); range.setStart(leaf.firstChild!, start); range.setEnd(leaf.firstChild!, end)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
}
function input(text: string, inputType = 'insertText') {
  act(() => { screen.getByRole('textbox', { name: 'Visual content' }).dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data: text })) })
}
describe('Visual Markdown editing', () => {
  it('renders without rewriting source and patches formatted text only', () => {
    const source = '## Heading\n\nA **bold** word.\n\n| A | B |\n| :- | -: |\n| One | Two |'
    render(<Editor source={source} />)
    expect(screen.getByTestId('source').textContent).toBe(source)
    select('bold', 0, 4); input('strong')
    expect(screen.getByTestId('source').textContent).toBe(source.replace('**bold**', '**strong**'))
    select('Two', 0, 3); input('Three')
    expect(screen.getByTestId('source').textContent).toContain('| One | Three |')
  })
  it('deletes an encoded entity as a whole and keeps code entities literal', () => {
    render(<Editor source={'A &amp; B\n\n`&amp;`'} />)
    select('A & B', 2, 3); input('and')
    expect(screen.getByTestId('source').textContent).toBe('A and B\n\n`&amp;`')
    select('&amp;', 1, 4); input('xyz')
    expect(screen.getByTestId('source').textContent).toBe('A and B\n\n`&xyz;`')
  })
  it('preserves quote prefixes while editing a soft continuation line', () => {
    render(<Editor source={'> One\n> Two'} />)
    select('One\nTwo', 4, 7); input('Next')
    expect(screen.getByTestId('source').textContent).toBe('> One\n> Next')
    expect(document.querySelector('blockquote p')?.textContent).toBe('One\nNext')
  })
  it('preserves paired formatting when replacing a selection across inline spans', () => {
    render(<Editor source="one **bold** two" />)
    const strong = document.querySelector('strong span')!.firstChild!
    const plain = [...document.querySelectorAll('[data-source-start]')].find(node => node.textContent === ' two')!.firstChild!
    const range = document.createRange(); range.setStart(strong, 2); range.setEnd(plain, 2)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    input('X')
    expect(screen.getByTestId('source').textContent).toBe('one **boX**wo')
    expect(document.querySelector('strong')?.textContent).toBe('boX')
  })
  it('creates paragraphs, supports undo and redo, and toggles ordered tasks', () => {
    render(<Editor source="One" />)
    select('One', 3); input('', 'insertParagraph'); input('Two')
    expect(screen.getByTestId('source').textContent).toBe('One\n\nTwo')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Visual content' }), { key: 'z', ctrlKey: true })
    expect(screen.getByTestId('source').textContent).toBe('One\n\n')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Visual content' }), { key: 'z', ctrlKey: true, shiftKey: true })
    expect(screen.getByTestId('source').textContent).toBe('One\n\nTwo')
    cleanup()
    render(<Editor source="1. [ ] Task" />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByTestId('source').textContent).toBe('1. [x] Task')
  })
  it('retains typed trailing spaces and the insertion point in an empty list item', () => {
    render(<Editor source="Second" />)
    select('Second', 6); input(' '); input('paragraph')
    expect(screen.getByTestId('source').textContent).toBe('Second paragraph')
    cleanup()
    render(<Editor source="- First" />)
    select('First', 5); input('', 'insertParagraph'); input('Second')
    expect(screen.getByTestId('source').textContent).toBe('- First\n- Second')
  })
  it('starts a list after prose without parsing an empty marker as a Setext underline', () => {
    const handle = createRef<VisualEditorHandle>()
    function ListEditor() {
      const [content, setContent] = useState('Body text')
      return <><VisualEditor ref={handle} content={content} disabled={false} onChange={value => { setContent(value); return true }} /><output data-testid="source">{content}</output></>
    }
    render(<ListEditor />)
    select('Body text', 9)
    act(() => handle.current!.format('\n- ', ''))
    input('First item'); input('', 'insertParagraph'); input('Second item')
    expect(screen.getByTestId('source').textContent).toBe('Body text\n\n- First item\n- Second item')
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['First item', 'Second item'])
  })
  it('selects editable placeholders when inline formatting starts at an empty caret', () => {
    for (const [before, after] of [['**', '**'], ['_', '_'], ['`', '`'], ['[', '](https://)']]) {
      const handle = createRef<VisualEditorHandle>()
      function InlineEditor() {
        const [content, setContent] = useState('')
        return <><VisualEditor ref={handle} content={content} disabled={false} onChange={value => { setContent(value); return true }} /><output data-testid="source">{content}</output></>
      }
      render(<InlineEditor />)
      act(() => handle.current!.format(before, after))
      input('done')
      expect(screen.getByTestId('source').textContent).toBe(before + 'done' + after)
      cleanup()
    }
  })
  it('uses plain clipboard text and keeps locked content read only', () => {
    render(<Editor source="Before" />)
    select('Before', 6)
    fireEvent.paste(screen.getByRole('textbox', { name: 'Visual content' }), { clipboardData: { getData: (format: string) => format === 'text/plain' ? ' safe' : '<img src="https://example.com/track">' } })
    expect(screen.getByTestId('source').textContent).toBe('Before safe')
    expect(document.querySelector('img')).toBeNull()
    cleanup()
    render(<Editor source="Locked" disabled />)
    select('Locked', 0, 6); input('Changed')
    expect(screen.getByTestId('source').textContent).toBe('Locked')
  })
})
