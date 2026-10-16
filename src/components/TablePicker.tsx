import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Table2 } from 'lucide-react'
import './TablePicker.css'

const GRID_SIZE = 8
export const MAX_TABLE_SIZE = 20

export function markdownTable(rows: number, columns: number): string {
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows > MAX_TABLE_SIZE || columns > MAX_TABLE_SIZE) {
    throw new Error(`Choose between 1 and ${MAX_TABLE_SIZE} rows and columns.`)
  }
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [
    line(Array.from({ length: columns }, (_, index) => `Header ${index + 1}`)),
    line(Array.from({ length: columns }, () => '---')),
    ...Array.from({ length: rows - 1 }, () => line(Array.from({ length: columns }, () => ''))),
  ].join('\n')
}

interface Props {
  disabled?: boolean
  onOpen(): void
  onInsert(rows: number, columns: number): void
}

export default function TablePicker({ disabled = false, onOpen, onInsert }: Props) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState('3')
  const [columns, setColumns] = useState('3')
  const [cell, setCell] = useState({ row: 3, column: 3 })
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 500 })
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const id = useId()
  const rowCount = Number(rows), columnCount = Number(columns)
  const valid = Number.isInteger(rowCount) && Number.isInteger(columnCount) && rowCount >= 1 && columnCount >= 1 && rowCount <= MAX_TABLE_SIZE && columnCount <= MAX_TABLE_SIZE

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(288, window.innerWidth - 16)
      const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 220))
      setPosition({ top, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), maxHeight: window.innerHeight - top - 8 })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])

  useEffect(() => {
    if (!open) return
    popup.current?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.focus()
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key) }
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  const choose = (row: number, column: number) => { setCell({ row, column }); setRows(String(row)); setColumns(String(column)) }
  const insert = (row: number, column: number) => { setOpen(false); onInsert(row, column) }
  return <>
    <button ref={trigger} type="button" className="icon-button" aria-label="Insert table" title="Insert table" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => {
      if (!open) onOpen()
      setOpen(value => !value)
    }}><Table2 size={16} /></button>
    {open && createPortal(<div ref={popup} className="table-picker" id={id} role="dialog" aria-label="Insert table" style={position} onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) setOpen(false)
    }}>
      <strong>Insert table</strong>
      <span className="table-picker-size" aria-live="polite">{valid ? `${columnCount} columns × ${rowCount} rows` : 'Choose a table size'}</span>
      <div className="table-picker-grid" role="grid" aria-label="Table size" aria-describedby={`${id}-hint`}>
        {Array.from({ length: GRID_SIZE }, (_, rowIndex) => <div role="row" key={rowIndex}>{Array.from({ length: GRID_SIZE }, (_, columnIndex) => {
          const row = rowIndex + 1, column = columnIndex + 1
          return <button key={column} type="button" role="gridcell" aria-label={`${column} columns, ${row} rows`} aria-selected={row <= rowCount && column <= columnCount} tabIndex={cell.row === row && cell.column === column ? 0 : -1} onPointerEnter={event => { if (event.pointerType !== 'touch') choose(row, column) }} onFocus={() => choose(row, column)} onClick={() => insert(row, column)} onKeyDown={event => {
            let nextRow = row, nextColumn = column
            if (event.key === 'ArrowUp') nextRow = Math.max(1, row - 1)
            else if (event.key === 'ArrowDown') nextRow = Math.min(GRID_SIZE, row + 1)
            else if (event.key === 'ArrowLeft') nextColumn = Math.max(1, column - 1)
            else if (event.key === 'ArrowRight') nextColumn = Math.min(GRID_SIZE, column + 1)
            else if (event.key === 'Home') { nextColumn = 1; if (event.ctrlKey) nextRow = 1 }
            else if (event.key === 'End') { nextColumn = GRID_SIZE; if (event.ctrlKey) nextRow = GRID_SIZE }
            else return
            event.preventDefault()
            choose(nextRow, nextColumn)
            popup.current?.querySelector<HTMLElement>(`[role="gridcell"][aria-label="${nextColumn} columns, ${nextRow} rows"]`)?.focus()
          }} />
        })}</div>)}
      </div>
      <p id={`${id}-hint`}>Rows include the header. Use the grid or enter a size up to {MAX_TABLE_SIZE} × {MAX_TABLE_SIZE}.</p>
      <form onSubmit={event => { event.preventDefault(); if (valid) insert(rowCount, columnCount) }}>
        <div className="table-picker-fields">
          <label>Columns<input type="number" min={1} max={MAX_TABLE_SIZE} step={1} value={columns} onChange={event => setColumns(event.target.value)} /></label>
          <label>Rows<input type="number" min={1} max={MAX_TABLE_SIZE} step={1} value={rows} onChange={event => setRows(event.target.value)} /></label>
        </div>
        <button type="submit" className="button primary" disabled={!valid}>Insert table</button>
      </form>
    </div>, document.body)}
  </>
}
