// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TablePicker, { markdownTable } from './TablePicker'

afterEach(cleanup)

describe('table insertion picker', () => {
  it('inserts the grid size directly and includes the header in its row count', () => {
    const onOpen = vi.fn(), onInsert = vi.fn()
    render(<TablePicker onOpen={onOpen} onInsert={onInsert} />)
    fireEvent.click(screen.getByRole('button', { name: 'Insert table' }))
    expect(onOpen).toHaveBeenCalledOnce()
    const dialog = screen.getByRole('dialog', { name: 'Insert table' })
    expect(dialog.textContent).toContain('Rows include the header')
    fireEvent.click(within(dialog).getByRole('gridcell', { name: '4 columns, 2 rows' }))
    expect(onInsert).toHaveBeenCalledExactlyOnceWith(2, 4)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('supports arrow keys, keyboard insertion, and Escape without changing the note', async () => {
    const user = userEvent.setup(), onInsert = vi.fn()
    render(<TablePicker onOpen={() => {}} onInsert={onInsert} />)
    const trigger = screen.getByRole('button', { name: 'Insert table' })
    await user.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: '3 columns, 3 rows' }))
    await user.keyboard('{ArrowRight}{ArrowDown}{Enter}')
    expect(onInsert).toHaveBeenCalledExactlyOnceWith(4, 4)
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(trigger)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onInsert).toHaveBeenCalledOnce()
  })

  it('allows a precise larger table and rejects empty, fractional, or oversized dimensions', () => {
    const onInsert = vi.fn()
    render(<TablePicker onOpen={() => {}} onInsert={onInsert} />)
    fireEvent.click(screen.getByRole('button', { name: 'Insert table' }))
    const dialog = screen.getByRole('dialog', { name: 'Insert table' })
    const columns = within(dialog).getByRole('spinbutton', { name: 'Columns' })
    const rows = within(dialog).getByRole('spinbutton', { name: 'Rows' })
    const submit = within(dialog).getByRole('button', { name: 'Insert table' }) as HTMLButtonElement
    for (const value of ['', '0', '2.5', '21']) {
      fireEvent.change(columns, { target: { value } })
      expect(submit.disabled).toBe(true)
    }
    fireEvent.change(columns, { target: { value: '12' } })
    fireEvent.change(rows, { target: { value: '20' } })
    expect(submit.disabled).toBe(false)
    fireEvent.submit(submit.closest('form')!)
    expect(onInsert).toHaveBeenCalledExactlyOnceWith(20, 12)
    expect(() => markdownTable(1_000_000, 20)).toThrow('Choose between')
  })

  it('closes when disabled or focus moves outside without inserting anything', () => {
    const onInsert = vi.fn()
    const { rerender } = render(<><TablePicker onOpen={() => {}} onInsert={onInsert} /><button>Elsewhere</button></>)
    fireEvent.click(screen.getByRole('button', { name: 'Insert table' }))
    fireEvent.blur(screen.getByRole('dialog'), { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Insert table' }))
    rerender(<TablePicker disabled onOpen={() => {}} onInsert={onInsert} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onInsert).not.toHaveBeenCalled()
  })
})
