import { useEffect, useMemo, useState } from 'react'
import { History, Pause, Play, RotateCcw, X } from 'lucide-react'
import Markdown from './Markdown'
import './HistoryPanel.css'

interface Props {
  entries: readonly { id: string; recordedAt: string; restoredFrom?: string }[]
  current: { title: string; content: string }
  readVersion: (id: string) => { title: string; content: string }
  disabled: boolean
  restore: (id: string) => void
  close: () => void
}

function timestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  })
}

/** A read-only projection. Only the explicit Restore button can change a note. */
export default function HistoryPanel({ entries, current, readVersion, disabled, restore, close }: Props) {
  const [selectedId, setSelectedId] = useState<string | undefined>(() => entries.at(-1)?.id)
  const [playing, setPlaying] = useState(false)
  const existingIndex = entries.findIndex(entry => entry.id === selectedId)
  const selectedIndex = Math.max(0, existingIndex < 0 ? entries.length - 1 : existingIndex)
  const selected = entries[selectedIndex]
  const preview = useMemo(() => {
    if (!selected) return null
    try { return { value: readVersion(selected.id), error: false } }
    catch { return { value: null, error: true } }
  }, [selected?.id, readVersion])
  const matchesCurrent = !!preview?.value && preview.value.title === current.title && preview.value.content === current.content
  const label = selected ? `Version ${selectedIndex + 1} of ${entries.length}` : 'No saved versions'
  const date = selected ? timestamp(selected.recordedAt) : ''
  const nextId = entries[selectedIndex + 1]?.id
  const nextIsLast = selectedIndex + 1 === entries.length - 1

  useEffect(() => {
    if (selected && existingIndex < 0) setSelectedId(selected.id)
  }, [selected?.id, existingIndex])

  useEffect(() => {
    if (!playing) return
    if (!nextId || preview?.error) {
      setPlaying(false)
      return
    }
    const timer = window.setTimeout(() => {
      setSelectedId(nextId)
      if (nextIsLast) setPlaying(false)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [playing, selected?.id, nextId, nextIsLast, preview?.error])

  function togglePlayback() {
    if (playing) { setPlaying(false); return }
    if (entries.length < 2) return
    if (selectedIndex >= entries.length - 1) setSelectedId(entries[0].id)
    setPlaying(true)
  }

  function closeHistory() {
    setPlaying(false)
    close()
  }

  return <section id="history-panel" className="history-panel" aria-label="Note history">
    <div className="history-controls">
      <header className="history-heading">
        <h2><History size={16} /> History</h2>
        <button className="icon-button" onClick={closeHistory} aria-label="Close history" title="Close history"><X size={18} /></button>
      </header>
      <p className="history-description">Versions are saved after you pause typing or save. Your history stays private.</p>
      {entries.length > 0 && <>
        <div className="history-timeline">
          <button className="history-play" onClick={togglePlayback} disabled={entries.length < 2} aria-label={playing ? 'Pause history' : 'Play history'} title={playing ? 'Pause history' : 'Play history'}>
            {playing ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <input type="range" min={0} max={Math.max(0, entries.length - 1)} step={1} value={selectedIndex} disabled={entries.length < 2} aria-label="Version timeline" aria-valuetext={`${label}, ${date}`} onChange={event => {
            setPlaying(false)
            const entry = entries[Number(event.target.value)]
            if (entry) setSelectedId(entry.id)
          }} />
        </div>
        <div className="history-version-details"><strong>{label}</strong><time dateTime={selected.recordedAt}>{date}</time>{selected.restoredFrom && <span className="history-restored"><RotateCcw size={11} /> Restored version</span>}</div>
      </>}
    </div>
    <div className="history-preview">
      {!selected ? <p className="history-empty">Your saved versions will appear here.</p> : preview?.error ? <p className="inline-error" role="alert">This version could not be opened. Try another version.</p> : preview?.value && <article aria-label="Version preview">
        <h3 className="history-note-title">{preview.value.title || 'Untitled note'}</h3>
        {preview.value.content ? <Markdown content={preview.value.content} /> : <p className="history-empty">This version is empty.</p>}
      </article>}
    </div>
    <footer className="history-footer">
      <div><p>Restoring adds a new version and keeps later edits.</p>{matchesCurrent && <span className="history-current">Matches your current note</span>}</div>
      <button className="button secondary small" disabled={disabled || !selected || !preview?.value || matchesCurrent} onClick={() => {
        if (disabled || !selected || !preview?.value || matchesCurrent) return
        setPlaying(false)
        restore(selected.id)
      }}><RotateCcw size={14} /> Restore this version</button>
    </footer>
  </section>
}
