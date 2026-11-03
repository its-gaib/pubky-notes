// @vitest-environment jsdom
import { createRef, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import VisualEditor, { EMPTY_VISUAL_EDITOR_STATE, VisualEditorToolbar } from './VisualEditor'
import type { VisualEditorHandle } from './VisualEditor'

afterEach(cleanup)
function Editor({ source, disabled = false }: { source: string; disabled?: boolean }) {
  const [content, setContent] = useState(source)
  const [state, setState] = useState(EMPTY_VISUAL_EDITOR_STATE)
  const editor = useRef<VisualEditorHandle>(null)
  return <><VisualEditorToolbar editor={editor} state={state} disabled={disabled} /><VisualEditor ref={editor} content={content} disabled={disabled} onStateChange={setState} onChange={value => { setContent(value); return true }} /><output data-testid="canonical">{content}</output><button onClick={() => setContent(value => `Remote\n\n${value}`)}>Remote edit</button></>
}
function select(text: string, start = 0, end = start) {
  const root = screen.getByRole('textbox', { name: 'Visual content' })
  const element = [...root.querySelectorAll<HTMLElement>('[data-source-start]')].find(node => node.textContent === text)!
  if (!element?.firstChild) throw new Error(`Missing leaf ${text}`)
  act(() => {
    root.focus()
    const range = document.createRange(); range.setStart(element.firstChild!, start); range.setEnd(element.firstChild!, end)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
}
const canonical = () => screen.getByTestId('canonical').textContent

describe('Visual formatting controls', () => {
  it('reflects and toggles existing bold and italic without nesting delimiters', () => {
    render(<Editor source="Before **bold** and _italic_." />)
    select('bold', 0, 4)
    expect(screen.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }))
    expect(canonical()).toBe('Before bold and _italic_.')
    expect(screen.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')).toBe('false')
    select('italic', 2)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Visual content' }), { key: 'i', ctrlKey: true })
    expect(canonical()).toBe('Before bold and italic.')
  })
  it('edits link destinations safely, preserves formatted labels, and removes links', () => {
    render(<Editor source={'[**label**](https://old.example/)'} />)
    fireEvent.click(screen.getByRole('link', { name: 'label' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit link' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Link URL' }), { target: { value: 'javascript:alert(1)' } })
    fireEvent.submit(dialog.querySelector('form')!)
    expect(screen.getByRole('alert').textContent).toContain('https://')
    expect(canonical()).toBe('[**label**](https://old.example/)')
    fireEvent.change(screen.getByRole('textbox', { name: 'Link URL' }), { target: { value: 'https://example.test/a(b)' } })
    fireEvent.submit(dialog.querySelector('form')!)
    expect(canonical()).toBe('[**label**](<https://example.test/a(b)>)')
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.test/a(b)')
    fireEvent.click(screen.getByRole('link'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }))
    expect(canonical()).toBe('**label**')
  })
  it('inserts links from selected prose and cancels stale dialogs on incoming edits', () => {
    render(<Editor source="Before label after" />)
    select('Before label after', 7, 12)
    fireEvent.click(screen.getByRole('button', { name: 'Link' }))
    expect((screen.getByRole('textbox', { name: 'Link text' }) as HTMLInputElement).value).toBe('label')
    fireEvent.change(screen.getByRole('textbox', { name: 'Link URL' }), { target: { value: '/local/notes/other.json' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save link' }))
    expect(canonical()).toBe('Before [label](</local/notes/other.json>) after')
    fireEvent.click(screen.getByRole('link'))
    fireEvent.click(screen.getByRole('button', { name: 'Remote edit' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(canonical()).toBe('Remote\n\nBefore [label](</local/notes/other.json>) after')
  })
  it('changes only the selected table, retaining alignment and escaped cell syntax', () => {
    const source = 'Before\n\n| Name | Value |\n| :--- | ---: |\n| One | a\\|b |\n\nAfter'
    render(<Editor source={source} />)
    select('One', 1)
    fireEvent.click(screen.getByRole('button', { name: 'Table options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert column right' }))
    expect(canonical()).toBe('Before\n\n| Name | Header | Value |\n| :--- | --- | ---: |\n| One |  | a\\|b |\n\nAfter')
    expect(screen.getAllByRole('columnheader').length).toBe(3)
    fireEvent.click(screen.getByRole('button', { name: 'Table options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert row below' }))
    expect(screen.getAllByRole('row').length).toBe(3)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Visual content' }), { key: 'z', ctrlKey: true })
    expect(screen.getAllByRole('row').length).toBe(2)
  })
  it('navigates table cells with Tab and grows a final bounded row', () => {
    render(<Editor source={'| A | B |\n| --- | --- |\n| One | Two |'} />)
    select('One', 1)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Visual content' }), { key: 'Tab' })
    expect(window.getSelection()?.toString()).toBe('Two')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Visual content' }), { key: 'Tab' })
    expect(screen.getAllByRole('row').length).toBe(3)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Visual content' }), { key: 'Tab', shiftKey: true })
    expect(window.getSelection()?.toString()).toBe('Two')
  })
  it('retains typed spaces in a new cell without folding padding into table content', () => {
    render(<Editor source={'| A | B |\n| --- | --- |\n| One | Two |'} />)
    select('Two', 3)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Visual content' }), { key: 'Tab' })
    const visual = screen.getByRole('textbox', { name: 'Visual content' })
    for (const text of ['New', ' ', 'row']) act(() => {
      visual.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
    })
    expect(canonical()).toContain('| New row |  |')
    expect(screen.getByRole('cell', { name: 'New row' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Table options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert column right' }))
    expect(canonical()).toContain('| New row |  |  |')
    expect(canonical()).not.toContain('New row  ')
  })
  it('keeps all editing controls disabled on a read-only note', () => {
    render(<Editor source="**Locked**" disabled />)
    for (const button of document.querySelectorAll<HTMLButtonElement>('.visual-formatting button')) expect(button.disabled).toBe(true)
    expect(canonical()).toBe('**Locked**')
  })
})
