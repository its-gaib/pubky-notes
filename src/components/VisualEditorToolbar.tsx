import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Bold, Code2, Heading2, Italic, Link, List, Quote, Table2 } from 'lucide-react'
import TablePicker from './TablePicker'
import type { VisualEditorHandle, VisualEditorState } from './VisualEditor'
import type { InlineFormat, TableAction } from '../lib/visual-tools'
import './VisualEditorTools.css'

export default function VisualEditorToolbar({ editor, state, disabled = false }: { editor: RefObject<VisualEditorHandle | null>; state: VisualEditorState; disabled?: boolean }) {
  const [tableOpen, setTableOpen] = useState(false)
  const tableMenu = useRef<HTMLDivElement>(null)
  const tableTrigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!tableOpen) return
    tableMenu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    const outside = (event: PointerEvent) => { if (!tableMenu.current?.contains(event.target as Node)) setTableOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [tableOpen])
  const formats: { name: string; format: InlineFormat; active: boolean; icon: typeof Bold }[] = [
    { name: 'Bold', format: 'bold', active: state.bold, icon: Bold },
    { name: 'Italic', format: 'italic', active: state.italic, icon: Italic },
    { name: 'Heading', format: 'heading', active: state.heading, icon: Heading2 },
    { name: 'List', format: 'list', active: state.list, icon: List },
    { name: 'Quote', format: 'quote', active: state.quote, icon: Quote },
    { name: 'Code', format: 'code', active: state.code, icon: Code2 },
  ]
  const actions: { label: string; action: TableAction; blocked?: boolean }[] = [
    { label: 'Insert row above', action: 'row-before', blocked: !state.canAddRow || state.headerCell },
    { label: 'Insert row below', action: 'row-after', blocked: !state.canAddRow },
    { label: 'Insert column left', action: 'column-before', blocked: !state.canAddColumn },
    { label: 'Insert column right', action: 'column-after', blocked: !state.canAddColumn },
    { label: 'Delete row', action: 'delete-row' },
    { label: 'Delete column', action: 'delete-column' },
  ]
  return <div className="formatting-toolbar visual-formatting" aria-label="Visual formatting">
    {formats.map(item => <button key={item.name} type="button" className="icon-button" aria-label={item.name} title={item.name} aria-pressed={item.active} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => editor.current?.toggleFormat(item.format)}><item.icon size={16} /></button>)}
    <button type="button" className="icon-button" aria-label="Link" title={state.link ? 'Edit link' : 'Insert link'} aria-pressed={state.link} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => editor.current?.openLinkEditor()}><Link size={16} /></button>
    <TablePicker disabled={disabled} onOpen={() => editor.current?.rememberSelection()} onInsert={(rows, columns) => editor.current?.insertTable(rows, columns)} />
    {state.table && <div ref={tableMenu} className="visual-table-menu">
      <button ref={tableTrigger} type="button" className="icon-button" aria-label="Table options" title="Table options" aria-haspopup="menu" aria-expanded={tableOpen} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => setTableOpen(value => !value)}><Table2 size={16} /></button>
      {tableOpen && <div className="visual-table-actions" role="menu" aria-label="Table options" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setTableOpen(false); tableTrigger.current?.focus(); return }
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
        if (next >= 0) { event.preventDefault(); items[next]?.focus() }
      }}>
        {actions.map(item => <button key={item.action} type="button" role="menuitem" disabled={disabled || item.blocked} onMouseDown={event => event.preventDefault()} onClick={() => { editor.current?.tableAction(item.action); setTableOpen(false) }}>{item.label}</button>)}
      </div>}
    </div>}
  </div>
}
