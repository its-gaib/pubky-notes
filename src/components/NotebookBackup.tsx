import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, InputHTMLAttributes } from 'react'
import { ArrowDownToLine, FileArchive, FolderOpen, LoaderCircle, Upload } from 'lucide-react'
import { createMarkdownArchive, createNotebookBackup, readNotebookImport } from '../lib/notebook-backup'
import type { NotebookExportSnapshot, NotebookImportPlan } from '../lib/notebook-backup'
import './NotebookBackup.css'

interface Props extends NotebookExportSnapshot {
  disabled?: boolean
  onPrepareExport?: () => Promise<NotebookExportSnapshot>
  onImport: (plan: NotebookImportPlan) => Promise<void>
}

function download(data: string | Uint8Array<ArrayBuffer>, filename: string, type: string) {
  const blob = new Blob([data], { type }), url = URL.createObjectURL(blob)
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
function message(error: unknown) { return error instanceof Error ? error.message : 'The notebook operation could not be completed.' }

/** This panel deliberately has no session access. The notebook owns scoped
 * persistence and supplies a fresh, flushed snapshot for every export. */
export default function NotebookBackup({ records, folders, disabled = false, onPrepareExport, onImport }: Props) {
  const [includeHistory, setIncludeHistory] = useState(true)
  const [includeTrash, setIncludeTrash] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [plan, setPlan] = useState<NotebookImportPlan | null>(null)
  const lifecycle = useRef(0)
  useEffect(() => {
    ++lifecycle.current
    return () => { ++lifecycle.current }
  }, [])
  const files = useRef<HTMLInputElement>(null), directory = useRef<HTMLInputElement>(null)
  const liveCount = records.filter(({ note }) => !note.deleted).length
  const trashCount = records.filter(({ note }) => note.deleted).length
  const locked = disabled || busy

  async function exportNotebook(markdown: boolean) {
    if (locked) return
    const generation = lifecycle.current
    setBusy(true); setError(''); setStatus('')
    try {
      const snapshot = onPrepareExport ? await onPrepareExport() : { records, folders }
      if (generation !== lifecycle.current) return
      const date = new Date().toISOString().slice(0, 10)
      if (markdown) {
        const archive = await createMarkdownArchive(snapshot)
        if (generation !== lifecycle.current) return
        download(archive, `pubky-notes-${date}.zip`, 'application/zip')
      }
      else download(createNotebookBackup(snapshot, { includeHistory, includeTrash }), `pubky-notes-${date}.pubky-notes.json`, 'application/json;charset=utf-8')
      setStatus(markdown ? 'Markdown archive downloaded.' : 'Notebook backup downloaded.')
    } catch (error) { if (generation === lifecycle.current) setError(message(error)) }
    finally { if (generation === lifecycle.current) setBusy(false) }
  }

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (!selected.length || locked) return
    const generation = lifecycle.current
    setBusy(true); setError(''); setStatus(''); setPlan(null)
    try {
      const prepared = await readNotebookImport(selected)
      if (generation === lifecycle.current) setPlan(prepared)
    }
    catch (error) { if (generation === lifecycle.current) setError(message(error)) }
    finally { if (generation === lifecycle.current) setBusy(false) }
  }

  async function importNotebook() {
    if (!plan || locked) return
    const generation = lifecycle.current
    setBusy(true); setError(''); setStatus('')
    try {
      await onImport(plan)
      if (generation !== lifecycle.current) return
      setStatus(`Imported ${plan.notes.length} ${plan.notes.length === 1 ? 'note' : 'notes'} and ${plan.folders.length} ${plan.folders.length === 1 ? 'folder' : 'folders'} as private copies.`)
      setPlan(null)
    } catch (error) { if (generation === lifecycle.current) setError(message(error)) }
    finally { if (generation === lifecycle.current) setBusy(false) }
  }

  return <div className="notebook-backup">
    <section aria-labelledby="notebook-export-heading">
      <h3 id="notebook-export-heading">Back up your notebook</h3>
      <p>Download all {liveCount} {liveCount === 1 ? 'note' : 'notes'} and their folders together. A notebook backup keeps exact titles, dates, and folder names.</p>
      <label className="backup-option"><input type="checkbox" checked={includeHistory} disabled={locked} onChange={event => setIncludeHistory(event.currentTarget.checked)} /> Include version history</label>
      <label className="backup-option"><input type="checkbox" checked={includeTrash} disabled={locked} onChange={event => setIncludeTrash(event.currentTarget.checked)} /> Include Trash ({trashCount})</label>
      <p className="hint">Backups are private, unencrypted files. Version history can include text you previously deleted. Your login and live collaboration credentials are never included.</p>
      <div className="backup-actions"><button className="button primary" disabled={locked} onClick={() => void exportNotebook(false)}><ArrowDownToLine size={15} /> Download notebook backup</button><button className="button secondary" disabled={locked} onClick={() => void exportNotebook(true)}><FileArchive size={15} /> Export Markdown ZIP</button></div>
      <p className="hint">Markdown ZIP contains current live notes and folders, without version history or Trash. Imports are limited to 32 MiB per selection and 2,000 notes.</p>
    </section>
    <section aria-labelledby="notebook-import-heading">
      <h3 id="notebook-import-heading">Import notes or restore a backup</h3>
      <p>Choose a notebook backup, a Markdown ZIP, multiple Markdown files, or a folder of Markdown files.</p>
      <div className="backup-actions"><button className="button secondary" disabled={locked} onClick={() => files.current?.click()}><Upload size={15} /> Choose files</button><button className="button secondary" disabled={locked} onClick={() => directory.current?.click()}><FolderOpen size={15} /> Choose folder</button></div>
      <input ref={files} className="backup-file-input" type="file" multiple accept=".json,.zip,.md,.markdown,.txt" aria-label="Import notebook files" onChange={event => void choose(event)} disabled={locked} />
      <input ref={directory} className="backup-file-input" type="file" multiple {...({ webkitdirectory: '', directory: '' } as InputHTMLAttributes<HTMLInputElement>)} aria-label="Import Markdown folder" onChange={event => void choose(event)} disabled={locked} />
      {plan && <div className="backup-plan" role="region" aria-label="Import preview">
        <h4>Ready to import</h4>
        <p>{plan.notes.length} {plan.notes.length === 1 ? 'note' : 'notes'} · {plan.folders.length} {plan.folders.length === 1 ? 'folder' : 'folders'}{plan.historyCount ? ` · ${plan.historyCount} with version history` : ''}{plan.deletedCount ? ` · ${plan.deletedCount} in Trash` : ''}</p>
        <p className="hint">Every imported note receives a new ID and stays private. Existing notes remain unchanged. No public copies or live collaboration connections are restored.</p>
        {plan.notes.length > 0 && <ul className="backup-preview-list">{plan.notes.slice(0, 5).map((note, index) => <li key={index}><strong>{note.title || 'Untitled note'}</strong>{note.folder && <span>{note.folder}</span>}{note.deleted && <span>Trash</span>}</li>)}{plan.notes.length > 5 && <li>and {plan.notes.length - 5} more…</li>}</ul>}
        <div className="backup-actions"><button className="button primary" disabled={locked || (!plan.notes.length && !plan.folders.length)} onClick={() => void importNotebook()}>Import private copies</button><button className="button ghost" disabled={locked} onClick={() => setPlan(null)}>Cancel import</button></div>
      </div>}
    </section>
    {busy && <p className="backup-progress" role="status"><LoaderCircle size={15} className="spin" /> Preparing notebook…</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {status && <p role="status" className="backup-result">{status}</p>}
  </div>
}
