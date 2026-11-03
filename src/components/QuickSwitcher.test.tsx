// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef } from 'react'
import QuickSwitcher, { HighlightedText } from './QuickSwitcher'
import type { NoteRecord } from '../lib/notes'

const rows: NoteRecord[] = [
  { note: { id: 'one', title: 'Ordinary title', content: `Opening ${'unrelated '.repeat(80)}NEEDLE token in the body.`, folder: 'Work/Deep', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }, published: null },
  { note: { id: 'two', title: 'Another title', content: 'Some text.', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' }, published: null },
  { note: { id: 'deleted', title: 'Deleted needle', content: 'This is in Trash.', deleted: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' }, published: null },
]
afterEach(cleanup)

describe('quick note switcher', () => {
  it('keeps the query focused after its surrounding modal initializes its focus trap', async () => {
    function Dialog() {
      const modal = useRef<HTMLDivElement>(null)
      useEffect(() => { modal.current?.focus() }, [])
      return <div ref={modal} role="dialog" tabIndex={-1}><QuickSwitcher records={rows} navigation={{ pinned: [], recent: [] }} onOpen={() => {}} onClose={() => {}} /></div>
    }
    render(<Dialog />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox')))
  })

  it('searches full note bodies, shows their matching excerpt, and opens via Enter', () => {
    const open = vi.fn(), close = vi.fn()
    render(<QuickSwitcher records={rows} navigation={{ pinned: [], recent: [] }} onOpen={open} onClose={close} />)
    const input = screen.getByRole('combobox', { name: 'Find a note' })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'needle token' } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(within(options[0]).getByText('Ordinary title')).toBeTruthy()
    expect(options[0].textContent).toContain('NEEDLE token in the body')
    expect(options[0].querySelector('mark')?.textContent).toBe('NEEDLE')
    expect(screen.queryByText('Deleted needle')).toBeNull()
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(open).toHaveBeenCalledExactlyOnceWith('one')
  })

  it('orders pins before recent notes, navigates results with keyboard, and closes with Escape', () => {
    const open = vi.fn(), close = vi.fn()
    render(<QuickSwitcher records={rows} navigation={{ pinned: ['one'], recent: ['two'] }} onOpen={open} onClose={close} />)
    const input = screen.getByRole('combobox')
    const options = screen.getAllByRole('option')
    expect(options[0].textContent).toContain('Ordinary title')
    expect(within(options[0]).getByLabelText('Pinned note')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(options[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'Home' })
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'End' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(open).toHaveBeenCalledExactlyOnceWith('two')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('never renders query or note HTML and communicates empty/disabled results', () => {
    const open = vi.fn()
    const unsafe: NoteRecord[] = [{ ...rows[0], note: { ...rows[0].note, title: '<img src=x>', content: '<script>alert(1)</script> literal text' } }]
    const { container, rerender } = render(<QuickSwitcher records={unsafe} navigation={{ pinned: [], recent: [] }} onOpen={open} onClose={() => {}} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '<script>' } })
    expect(container.querySelector('script, img')).toBeNull()
    expect(screen.getByRole('option').textContent).toContain('<script>')
    rerender(<QuickSwitcher records={unsafe} navigation={{ pinned: [], recent: [] }} disabled onOpen={open} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('option'))
    expect(open).not.toHaveBeenCalled()
    rerender(<QuickSwitcher records={[]} navigation={{ pinned: [], recent: [] }} onOpen={open} onClose={() => {}} />)
    expect(screen.getByRole('status').textContent).toBe('No notes match this text.')
    expect(screen.getByRole('combobox').hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('exposes highlighted source characters only as text', () => {
    const { container } = render(<HighlightedText parts={[{ text: '<b>literal</b>', match: true }, { text: ' plain', match: false }]} />)
    expect(container.textContent).toBe('<b>literal</b> plain')
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('mark')?.textContent).toBe('<b>literal</b>')
  })
})
