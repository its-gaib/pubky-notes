// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import VisualEditor from './VisualEditor'

afterEach(cleanup)
function Editor({ source }: { source: string }) {
  const [content, setContent] = useState(source)
  return <><VisualEditor content={content} disabled={false} onChange={value => { setContent(value); return true }} /><output data-testid="canonical">{content}</output></>
}
function leaf(text: string) {
  const element = [...document.querySelectorAll<HTMLElement>('[data-source-start]')].find(node => node.textContent === text)
  if (!element?.firstChild) throw new Error(`Missing rendered leaf ${JSON.stringify(text)}`)
  return element.firstChild
}
function select(from: Node, start: number, to = from, end = start) {
  const range = document.createRange(); range.setStart(from, start); range.setEnd(to, end)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
}
function selectAll() {
  const range = document.createRange(); range.selectNodeContents(screen.getByRole('textbox', { name: 'Visual content' }))
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
}
function input(text: string, inputType = 'insertText') {
  act(() => { screen.getByRole('textbox', { name: 'Visual content' }).dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data: text })) })
}
const canonical = () => screen.getByTestId('canonical').textContent

describe('Visual editing across Markdown boundaries', () => {
  it('removes fully selected formatting when replacement starts outside it', () => {
    render(<Editor source="one **bold** two" />)
    select(leaf('one '), 0, leaf('bold'), 4)
    input('X')
    expect(canonical()).toBe('X two')
    expect(screen.getByRole('textbox', { name: 'Visual content' }).textContent).toBe('X two')
  })

  it('keeps the unselected remainder of a formatted span', () => {
    render(<Editor source="one **bold** two" />)
    select(leaf('one '), 2, leaf('bold'), 2)
    input('X')
    expect(canonical()).toBe('onX**ld** two')
    expect(document.querySelector('strong')?.textContent).toBe('ld')
  })

  it('replaces a document containing adjacent formatted spans without empty delimiters', () => {
    render(<Editor source="**first** **second**" />)
    selectAll(); input('Replacement')
    const visual = screen.getByRole('textbox', { name: 'Visual content' })
    expect(visual.textContent).toBe('Replacement')
    expect(canonical()).not.toContain('****')
  })

  for (const source of ['[label](https://example.com)', '`literal`', '```js\nconst x = 1\n```']) {
    it(`deletes an entire ${source.startsWith('[') ? 'link' : source.startsWith('```') ? 'fenced code block' : 'inline code span'}`, () => {
      render(<Editor source={source} />)
      selectAll(); input('', 'deleteContentBackward')
      expect(canonical()).toBe('')
    })
  }

  it('inserts after a decoded entity without splitting its source token', () => {
    render(<Editor source={'A &amp; B'} />)
    select(leaf('A & B'), 3); input(' new')
    expect(canonical()).toBe('A &amp; new B')
  })

  it('preserves an escaped reference while editing the surrounding text', () => {
    render(<Editor source={'\\&fjlig; rest'} />)
    const text = leaf('&fjlig; rest')
    select(text, 12); input('!')
    expect(canonical()).toBe('\\&fjlig; rest!')
  })

  it('can replace one visible character of a multi-character entity', () => {
    render(<Editor source={'&fjlig; rest'} />)
    select(leaf('fj rest'), 0, leaf('fj rest'), 1); input('F')
    expect(screen.getByRole('textbox', { name: 'Visual content' }).textContent).toBe('Fj rest')
  })
})
