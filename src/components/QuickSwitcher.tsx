import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { FileText, Pin, Search } from 'lucide-react'
import type { NoteRecord } from '../lib/notes'
import { searchNotes } from '../lib/note-search'
import type { HighlightPart } from '../lib/note-search'
import { sortNavigableNotes } from '../lib/note-navigation'
import type { NoteNavigation } from '../lib/note-navigation'
import './QuickSwitcher.css'

export function HighlightedText({ parts }: { parts: readonly HighlightPart[] }) {
  return <>{parts.map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>)}</>
}
export type QuickSwitcherProps = {
  records: readonly NoteRecord[]
  navigation: NoteNavigation
  disabled?: boolean
  onOpen(id: string): void
  onClose(): void
}

/** The parent owns the modal/focus trap and keys this component by notebook
 * scope. Its list contains only the records supplied by that current scope. */
export default function QuickSwitcher({ records, navigation, disabled = false, onOpen, onClose }: QuickSwitcherProps) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0)
  const field = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const rows = useMemo(() => sortNavigableNotes(records, navigation), [records, navigation])
  const matches = useMemo(() => searchNotes(rows, query), [rows, query])
  const active = Math.min(selected, Math.max(0, matches.length - 1))
  const opened = useRef(false)
  useEffect(() => {
    field.current?.focus()
    // The surrounding modal also focuses its dialog in a parent effect.
    // Focus the search after that effect has installed the focus trap.
    queueMicrotask(() => field.current?.focus())
  }, [])
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [active, query])
  function open(index: number) {
    if (disabled || opened.current || !matches[index]) return
    opened.current = true
    onOpen(matches[index].row.note.id)
  }
  function keydown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    if (event.key === 'Enter') { event.preventDefault(); open(active); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const last = Math.max(0, matches.length - 1)
      setSelected(event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, active + (event.key === 'ArrowDown' ? 1 : -1))))
    }
  }
  return <div className="quick-switcher">
    <label className="quick-switcher-search"><Search size={17} aria-hidden="true" /><input ref={field} role="combobox" aria-label="Find a note" placeholder="Search titles and note text…" autoComplete="off" spellCheck={false} aria-expanded="true" aria-controls={`${id}-results`} aria-autocomplete="list" aria-activedescendant={matches.length ? `${id}-result-${active}` : undefined} value={query} disabled={disabled} onChange={event => { opened.current = false; setQuery(event.currentTarget.value); setSelected(0) }} onKeyDown={keydown} /></label>
    <p className="quick-switcher-hint">{query.trim() ? `${matches.length} ${matches.length === 1 ? 'note matches' : 'notes match'} across titles and full note text` : 'Pinned and recently opened notes'}<span>↑↓ to choose · Enter to open</span></p>
    <div ref={list} id={`${id}-results`} className="quick-switcher-results" role="listbox" aria-label="Matching notes" aria-busy={disabled}>
      {matches.map((match, index) => {
        const note = match.row.note
        return <div role="option" id={`${id}-result-${index}`} key={note.id} aria-selected={index === active} aria-disabled={disabled} className={`quick-switcher-result ${index === active ? 'active' : ''}`} onMouseMove={() => setSelected(index)} onMouseDown={event => event.preventDefault()} onClick={() => open(index)}>
          <FileText size={16} aria-hidden="true" />
          <div className="quick-switcher-result-text"><strong><HighlightedText parts={match.title} /></strong><span className="quick-switcher-folder">{note.folder || 'Notes'}</span>{match.excerptText && <p><HighlightedText parts={match.excerpt} /></p>}</div>
          {navigation.pinned.includes(note.id) && <Pin size={14} aria-label="Pinned note" />}
        </div>
      })}
    </div>
    {!matches.length && <p className="quick-switcher-empty" role="status">{query.trim() ? 'No notes match this text.' : 'No notes to open yet.'}</p>}
  </div>
}
