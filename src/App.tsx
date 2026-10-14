import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { Session } from '@synonymdev/pubky'
import QRCode from 'qrcode'
import { ArrowDownToLine, ArrowUpFromLine, BookOpen, CheckCheck, ChevronLeft, ChevronRight, CircleHelp, Code2, Copy, FileText, Folder, Globe2, Heading2, Link, List, LoaderCircle, LockKeyhole, PenLine, Plus, Search, RefreshCw, Trash2, X, Bold, Italic, Quote, ExternalLink } from 'lucide-react'
import Markdown from './components/Markdown'
import AccountProfile from './components/AccountProfile'
import { IS_TESTNET } from './config'
import { discardSession, persistSession, restoreSession, signOut, startSignIn } from './lib/pubky'
import type { AuthFlow } from './lib/pubky'
import { createNote, deleteNote, listNotes, loadPublicNote, publishNote, saveNote, unpublishNote } from './lib/notes'
import type { Note, NoteRecord } from './lib/notes'
import { filterNotes, folderLabel, folderPaths, normalizeFolder } from './lib/folders'

const SAMPLE_MARKDOWN = [
  '## Heading',
  '**Bold**, *italic*, and `code`.',
  '[Link](https://pubky.org)',
  '',
  '- Bullet item',
  '- [ ] Task',
  '1. Numbered item',
  '',
  '> Quote',
].join('\n')

const LAYOUT_KEY = 'pubky-notes:layout'
function savedLayout() {
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
    return { navigationCollapsed: value?.navigationCollapsed === true, notesCollapsed: value?.notesCollapsed === true }
  } catch { return { navigationCollapsed: false, notesCollapsed: false } }
}

function scratchpad(): NoteRecord {
  return { note: { ...createNote(), title: 'Markdown basics', content: SAMPLE_MARKDOWN }, published: null }
}
function errorMessage(error: unknown) {
  const name = error instanceof Error ? error.name : ''
  if (name === 'PkarrError') return `Could not find this identity on ${IS_TESTNET ? 'the local testnet' : 'mainnet'}. Check your network and Pubky Ring account.`
  if (name === 'AuthenticationError') return 'Your Pubky session needs attention. Reconnect your identity and try again.'
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}
function dateLabel(value: string) { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
function publicUrl(owner: string, id: string) { const url = new URL(window.location.origin); url.searchParams.set('owner', owner); url.searchParams.set('note', id); return url.href }
function download(note: Note) {
  const blob = new Blob([`# ${note.title || 'Untitled note'}\n\n${note.content}`], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${(note.title || 'Untitled note').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 80) || 'note'}.md`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus()
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
      if (event.key !== 'Tab') return
      const targets = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, textarea, [tabindex="0"]')
      if (!targets?.length) { event.preventDefault(); return }
      const first = targets[0], last = targets[targets.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [close])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}><div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><div className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="Close dialog"><X size={19} /></button></div>{children}</div></div>
}

function PublicNote({ owner, id }: { owner: string; id: string }) {
  const [note, setNote] = useState<Note | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { let canceled = false; loadPublicNote(owner, id).then(value => { if (!canceled) setNote(value) }).catch(() => { if (!canceled) setError('This note is unavailable. It may have been unpublished, or the homeserver could not be reached.') }); return () => { canceled = true } }, [owner, id])
  return <div className="public-shell"><header className="public-header"><a className="brand" href="/"><span className="brand-mark"><BookOpen size={22} /></span><strong>Pubky Notes</strong></a><span className="visibility-badge public"><Globe2 size={14} /> Public note</span></header><main className="public-article">{error ? <div className="empty-state"><FileText size={36} /><h1>Note unavailable</h1><p role="alert">{error}</p><a href="/" className="button secondary">Open your notebook</a></div> : note ? <><div className="note-byline">{dateLabel(note.updatedAt)}</div><h1>{note.title || 'Untitled note'}</h1><Markdown content={note.content} /><footer className="public-footer"><span>Shared by {owner.slice(0, 8)}…{owner.slice(-6)}</span><button className="button ghost small" onClick={() => download(note)}><ArrowDownToLine size={15} /> Download Markdown</button></footer></> : <div className="empty-state"><LoaderCircle className="spin" /><p>Opening public note…</p></div>}</main></div>
}

export default function App() {
  const params = new URLSearchParams(window.location.search)
  if (params.has('owner') && params.has('note')) return <PublicNote owner={params.get('owner')!} id={params.get('note')!} />
  return <Notebook />
}

function Notebook() {
  const [records, setRecords] = useState<NoteRecord[]>(() => [scratchpad()])
  const [activeId, setActiveId] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const [initializing, setInitializing] = useState(true)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'private' | 'public'>('all')
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [folderInput, setFolderInput] = useState('')
  const [folderError, setFolderError] = useState('')
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const [status, setStatus] = useState('Not saved')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null)
  const [modal, setModal] = useState<'auth' | 'share' | 'delete' | 'help' | 'move' | null>(null)
  const [authUrl, setAuthUrl] = useState('')
  const [qr, setQr] = useState('')
  const [authError, setAuthError] = useState('')
  const [authStarting, setAuthStarting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileList, setMobileList] = useState(true)
  const [mobileViewport, setMobileViewport] = useState(() => window.matchMedia?.('(max-width: 700px)')?.matches ?? false)
  const [layout, setLayout] = useState(savedLayout)
  const recordsRef = useRef(records); recordsRef.current = records
  const sessionRef = useRef(session); sessionRef.current = session
  const revisions = useRef(new Map<string, string>())
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const authFlow = useRef<AuthFlow | null>(null)
  const authEpoch = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const editor = useRef<HTMLTextAreaElement>(null)
  const importer = useRef<HTMLInputElement>(null)
  const active = records.find(row => row.note.id === activeId) ?? records[0]
  const note = active?.note
  const owner = session?.info.publicKey.z32() ?? ''
  const notice = useCallback((message: string, error = false) => setToast({ message, error }), [])
  const closeModal = useCallback(() => { authEpoch.current++; authFlow.current?.cancel(); authFlow.current = null; setModal(null); setAuthStarting(false) }, [])

  useEffect(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch { /* Layout still works when browser storage is unavailable. */ }
  }, [layout])
  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 700px)')
    if (!query) return
    const update = () => { setMobileViewport(query.matches); if (!query.matches) setMenuOpen(false) }
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  const enqueue = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const pending = queue.current.then(work, work); queue.current = pending.catch(() => {}); return pending
  }, [])
  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const currentSession = sessionRef.current
    if (!currentSession) return
    return enqueue(async () => {
      for (const row of recordsRef.current) {
        const draft = row.note
        if (revisions.current.get(draft.id) === draft.updatedAt) continue
        setStatus('Saving…')
        try {
          await saveNote(currentSession, draft)
          revisions.current.set(draft.id, draft.updatedAt)
          if (sessionRef.current === currentSession) setStatus(recordsRef.current.every(r => revisions.current.get(r.note.id) === r.note.updatedAt) ? 'Saved' : 'Unsaved changes')
        } catch (error) { setStatus('Not saved'); throw error }
      }
    })
  }, [enqueue])

  useEffect(() => {
    let canceled = false
    restoreSession().then(async saved => {
      if (!saved || canceled) return
      setLoading(true)
      setSession(saved); setRecords([]); setActiveId('')
      const loaded = await listNotes(saved)
      if (canceled) return
      revisions.current = new Map(loaded.map(row => [row.note.id, row.note.updatedAt]))
      setRecords(loaded); setActiveId(loaded[0]?.note.id ?? ''); setSession(saved); setStatus('Saved')
    }).catch(error => { if (!canceled) notice(errorMessage(error), true) }).finally(() => { if (!canceled) { setInitializing(false); setLoading(false) } })
    return () => { canceled = true }
  }, [notice])
  useEffect(() => {
    if (!session || loading || busy) return
    if (records.some(row => revisions.current.get(row.note.id) !== row.note.updatedAt)) {
      timer.current = setTimeout(() => { flush().catch(error => notice(errorMessage(error), true)) }, 900)
    }
    return () => clearTimeout(timer.current)
  }, [records, session, loading, busy, flush, notice])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (sessionRef.current && recordsRef.current.some(row => revisions.current.get(row.note.id) !== row.note.updatedAt)) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  useEffect(() => { if (!toast || toast.error) return; const id = setTimeout(() => setToast(null), 4500); return () => clearTimeout(id) }, [toast])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); flush().then(() => notice(!recordsRef.current.length ? 'Create a note to save your Markdown.' : sessionRef.current ? 'Notes saved to Pubky.' : 'Connect Pubky to save, or export your Markdown.')).catch(error => notice(errorMessage(error), true)) } }
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut)
  }, [flush, notice])

  function edit(patch: Partial<Pick<Note, 'title' | 'content'>>) {
    if (!note || busy) return
    const next = { ...note, ...patch, updatedAt: new Date().toISOString() }
    setRecords(current => current.map(row => row.note.id === note.id ? { ...row, note: next } : row))
    setStatus(session ? 'Unsaved changes' : 'Not saved')
  }
  async function addNote(imported?: { title: string; content: string }) {
    try {
      await flush()
      const draft = { ...createNote(), content: SAMPLE_MARKDOWN, folder: selectedFolder || undefined, ...(imported ?? {}) }
      setRecords(current => [{ note: draft, published: null }, ...current]); setActiveId(draft.id); setMode('write'); setQuery(''); setFilter('all'); setMobileList(false); setMenuOpen(false)
      setStatus(session ? 'Unsaved changes' : 'Not saved')
    } catch (error) { notice(errorMessage(error), true) }
  }
  async function switchNote(id: string) {
    try { await flush(); setActiveId(id); setMobileList(false) } catch (error) { notice(errorMessage(error), true) }
  }
  function openFolder(path: string) {
    setSelectedFolder(path); setFilter('all'); setQuery(''); setMobileList(true); setMenuOpen(false)
  }
  function toggleFolder(path: string) {
    setCollapsedFolders(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  async function moveNote() {
    if (!note || busy) return
    setFolderError('')
    let folder: string
    try { folder = normalizeFolder(folderInput) } catch (error) { setFolderError(errorMessage(error)); return }
    setBusy(true)
    try {
      await flush()
      const moved = { ...note, folder: folder || undefined, updatedAt: new Date().toISOString() }
      if (session) {
        await enqueue(() => saveNote(session, moved))
        revisions.current.set(moved.id, moved.updatedAt)
      }
      setRecords(current => current.map(row => row.note.id === moved.id ? { ...row, note: moved } : row))
      setSelectedFolder(folder); setFilter('all'); setQuery(''); setModal(null)
      setCollapsedFolders(current => new Set([...current].filter(path => !folder.startsWith(`${path}/`))))
      setStatus(session ? 'Saved' : 'Not saved')
    } catch (error) { setFolderError(errorMessage(error)) } finally { setBusy(false) }
  }
  async function connect() {
    setModal('auth'); setAuthStarting(true); setAuthError(''); setAuthUrl(''); setQr('')
    const epoch = ++authEpoch.current
    authFlow.current?.cancel()
    let candidate: Session | null = null
    let storedId: string | undefined
    try {
      const flow = await startSignIn()
      if (epoch !== authEpoch.current) { flow.cancel(); void flow.awaitApproval.catch(() => {}); return }
      authFlow.current = flow; setAuthUrl(flow.authorizationUrl); setAuthStarting(false)
      void QRCode.toDataURL(flow.authorizationUrl, { width: 240, margin: 2, color: { dark: '#252a40', light: '#ffffff' } }).then(value => { if (epoch === authEpoch.current) setQr(value) })
      const signedIn = await flow.awaitApproval
      candidate = signedIn
      if (epoch !== authEpoch.current) { await discardSession(signedIn); candidate = null; return }
      setAuthStarting(true)
      const loaded = await listNotes(signedIn)
      if (epoch !== authEpoch.current) { await discardSession(signedIn); candidate = null; return }
      storedId = await persistSession(signedIn)
      if (epoch !== authEpoch.current) { await discardSession(signedIn, storedId); candidate = null; return }
      revisions.current = new Map(loaded.map(row => [row.note.id, row.note.updatedAt]))
      setRecords(loaded); setActiveId(loaded[0]?.note.id ?? ''); setSession(signedIn); setStatus('Saved'); setModal(null); setAuthStarting(false); setQuery(''); setFilter('all'); setSelectedFolder(null); setCollapsedFolders(new Set()); notice('Connected. Your notebook is ready.')
      candidate = null
    } catch (error) {
      if (candidate) await discardSession(candidate, storedId).catch(() => undefined)
      if (epoch === authEpoch.current) { setAuthError(errorMessage(error)); setAuthStarting(false) }
    }
  }
  async function disconnect() {
    if (!session) return
    setBusy(true)
    try { await flush(); await enqueue(() => signOut(session)); const example = scratchpad(); setSession(null); setRecords([example]); setActiveId(example.note.id); revisions.current.clear(); setStatus('Not saved'); setMode('write'); setSelectedFolder(null); setCollapsedFolders(new Set()); setQuery(''); setFilter('all'); notice('Disconnected from Pubky.') } catch (error) { notice(errorMessage(error), true) } finally { setBusy(false) }
  }
  async function sharing(action: 'publish' | 'unpublish') {
    if (!session || !note) return
    setBusy(true)
    try {
      await flush()
      if (action === 'publish') { const published = await enqueue(() => publishNote(session, note)); setRecords(current => current.map(row => row.note.id === note.id ? { ...row, published } : row)); notice('Public copy published. Your private draft stays in your notebook.') }
      else { await enqueue(() => unpublishNote(session, note.id)); setRecords(current => current.map(row => row.note.id === note.id ? { ...row, published: null } : row)); notice('Public copy removed.') }
    } catch (error) { notice(errorMessage(error), true) } finally { setBusy(false) }
  }
  async function remove() {
    if (!note) return
    setBusy(true)
    try {
      await flush()
      if (session) await enqueue(() => deleteNote(session, note.id))
      setRecords(current => current.filter(row => row.note.id !== note.id)); revisions.current.delete(note.id); setActiveId(''); setModal(null); notice('Note deleted.')
    } catch (error) { notice(errorMessage(error), true) } finally { setBusy(false) }
  }
  async function refresh() {
    if (!session) return
    setLoading(true)
    try { await flush(); const loaded = await listNotes(session); revisions.current = new Map(loaded.map(row => [row.note.id, row.note.updatedAt])); setRecords(loaded); notice('Notebook refreshed.') } catch (error) { notice(errorMessage(error), true) } finally { setLoading(false) }
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file) return
    if (file.size > 512 * 1024) { notice('Choose a Markdown file smaller than 512 KB.', true); return }
    try { const content = await file.text(); const heading = content.match(/^# (.+)\r?\n/); await addNote({ title: (heading?.[1] ?? file.name.replace(/\.(md|markdown|txt)$/i, '')).slice(0, 200), content: heading ? content.slice(heading[0].length).replace(/^\r?\n/, '') : content }) } catch (error) { notice(errorMessage(error), true) }
  }
  function format(before: string, after = '') {
    if (!editor.current || !note) return
    const { selectionStart: start, selectionEnd: end } = editor.current
    const selection = note.content.slice(start, end)
    edit({ content: note.content.slice(0, start) + before + selection + after + note.content.slice(end) })
    requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(start + before.length, end + before.length) })
  }
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); notice('Copied to clipboard.') } catch { notice('Clipboard access was blocked. Select and copy the link instead.', true) } }
  const paths = folderPaths(records)
  const searching = !!query.trim()
  const filtered = filterNotes(records, query, filter, selectedFolder).sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt))
  const listTitle = searching ? 'Search results' : selectedFolder !== null ? folderLabel(selectedFolder) || 'Unfiled' : filter === 'all' ? 'All notes' : filter === 'private' ? 'Private notes' : 'Public notes'
  const words = note?.content.trim().split(/\s+/).filter(Boolean).length ?? 0
  const publicChanged = active?.published && (active.published.content !== note?.content || active.published.title !== note?.title)
  const locked = busy || loading || initializing
  const navigationCollapsed = mobileViewport ? !menuOpen : layout.navigationCollapsed
  const notesCollapsed = mobileViewport ? !mobileList : layout.notesCollapsed
  const bothCollapsed = navigationCollapsed && notesCollapsed
  function expandSidebars() {
    if (mobileViewport) { setMenuOpen(true); setMobileList(true) }
    else setLayout({ navigationCollapsed: false, notesCollapsed: false })
  }

  return <div className={`app-shell ${menuOpen ? 'mobile-open' : ''} ${mobileList ? 'mobile-list' : ''} ${navigationCollapsed ? 'navigation-collapsed' : ''} ${notesCollapsed ? 'notes-collapsed' : ''} ${bothCollapsed ? 'both-collapsed' : ''}`}>
    {menuOpen && <button className="navigation-dismiss" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <div className="navigation-pane"><aside className="sidebar" id="notebook-navigation">
      <a className="brand" href="/"><span className="brand-mark"><BookOpen size={22} /></span><strong>Pubky Notes</strong></a>
      <button className="new-note-button" onClick={() => void addNote()} disabled={locked}><Plus size={18} /> New note</button>
      <nav className="nav-group" aria-label="Notebook filters">{([{ key: 'all', label: 'All notes', icon: FileText }, { key: 'private', label: 'Private', icon: LockKeyhole }, { key: 'public', label: 'Public', icon: Globe2 }] as const).map(item => <button key={item.key} className={`nav-item ${selectedFolder === null && filter === item.key ? 'active' : ''}`} onClick={() => { setFilter(item.key); setSelectedFolder(null); setQuery(''); setMobileList(true); setMenuOpen(false) }}><item.icon size={17} /><span>{item.label}</span></button>)}</nav>
      <div className="folder-section">
        <button className={`nav-item folder-root ${selectedFolder === '' ? 'active' : ''}`} onClick={() => openFolder('')}><Folder size={17} /><span>Unfiled</span></button>
        <nav className="folder-tree" aria-label="Folders">{paths.map(path => {
          const segments = path.split('/')
          if (segments.some((_, index) => index > 0 && collapsedFolders.has(segments.slice(0, index).join('/')))) return null
          const hasChildren = paths.some(other => other.startsWith(`${path}/`))
          return <div className="folder-row" key={path} style={{ paddingLeft: Math.min(40, (segments.length - 1) * 10) }}>
            {hasChildren ? <button className="folder-toggle" aria-label={`${collapsedFolders.has(path) ? 'Expand' : 'Collapse'} folder ${path}`} aria-expanded={!collapsedFolders.has(path)} onClick={() => toggleFolder(path)}><ChevronRight size={13} style={{ transform: collapsedFolders.has(path) ? undefined : 'rotate(90deg)' }} /></button> : <span className="folder-toggle" />}
            <button className={`folder-select ${selectedFolder === path ? 'active' : ''}`} aria-label={`Open folder ${path}`} title={path} onClick={() => openFolder(path)}><Folder size={15} /><span>{folderLabel(path)}</span></button>
          </div>
        })}</nav>
      </div>
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={() => importer.current?.click()} disabled={locked}><ArrowUpFromLine size={16} /><span>Import Markdown</span></button>
        <button className="nav-item" onClick={() => setModal('help')}><CircleHelp size={16} /><span>Help</span></button>
        {!session && <button className="button primary sidebar-connect" onClick={() => void connect()} disabled={initializing || authStarting} aria-busy={initializing}>Connect Pubky</button>}
        {session && <AccountProfile owner={owner} disabled={locked} copy={copy} disconnect={() => void disconnect()} />}
        {IS_TESTNET && <span className="network-label">Local testnet</span>}
      </div>
    </aside>{bothCollapsed ? <button className="pane-toggle navigation-edge" aria-label="Expand sidebars" title="Expand sidebars" aria-controls="notebook-navigation notebook-notes" aria-expanded={false} onClick={expandSidebars}><ChevronRight size={17} /></button> : <button className="pane-toggle navigation-edge" aria-label={navigationCollapsed ? 'Expand navigation' : 'Collapse navigation'} title={navigationCollapsed ? 'Expand navigation' : 'Collapse navigation'} aria-controls="notebook-navigation" aria-expanded={!navigationCollapsed} onClick={() => mobileViewport ? setMenuOpen(current => !current) : setLayout(current => ({ ...current, navigationCollapsed: !current.navigationCollapsed }))}>{navigationCollapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}</button>}</div>
    <div className="notes-pane"><section className="notes-panel" id="notebook-notes" aria-label="Notes">
      <div className="notes-header"><h2 title={selectedFolder || undefined}><span className="notes-heading-label">{listTitle}</span><span className="count">{filtered.length}</span></h2><div className="notes-header-actions">{session && <button className="icon-button" aria-label="Refresh notes" title="Refresh notes" disabled={locked} onClick={() => void refresh()}><RefreshCw size={16} /></button>}<button className="icon-button" aria-label="Create a new note" disabled={locked} onClick={() => void addNote()}><PenLine size={18} /></button></div></div>
      <div className="search-box"><Search size={16} /><input type="search" placeholder="Search all notes…" aria-label="Search all notes" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button search-clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}</div>
      <div className="note-list">{filtered.map(row => <button key={row.note.id} className={`note-card ${row.note.id === note?.id ? 'selected' : ''}`} onClick={() => void switchNote(row.note.id)} disabled={locked}><div className="note-card-title"><FileText size={15} /><strong>{row.note.title || 'Untitled note'}</strong>{row.published ? <Globe2 size={13} /> : <LockKeyhole size={13} />}</div><p className="note-card-excerpt">{row.note.content.replace(/[#*>`_\[\]]/g, '').trim().slice(0, 115)}</p><div className="note-card-meta"><span>{dateLabel(row.note.updatedAt)}</span>{searching && <span className="folder-path" title={row.note.folder || 'Unfiled'}><Folder size={11} /><span>{row.note.folder || 'Unfiled'}</span></span>}</div></button>)}{!records.length && !initializing && !loading && <button className="note-card selected" onClick={() => setMobileList(false)}><div className="note-card-title"><Code2 size={15} /><strong>Markdown basics</strong></div><div className="note-card-meta">Sample</div></button>}{!filtered.length && records.length > 0 && <div className="empty-state"><Search size={25} /><p>{searching ? 'No notes match your search.' : 'No notes.'}</p><button className="button ghost small" onClick={() => { if (searching || filter !== 'all' || selectedFolder !== null) { setQuery(''); setFilter('all'); setSelectedFolder(null) } else void addNote() }}> {searching || filter !== 'all' || selectedFolder !== null ? 'Show all notes' : 'New note'}</button></div>}</div>
    </section>{!bothCollapsed && <button className="pane-toggle notes-edge" aria-label={notesCollapsed ? 'Expand notes' : 'Collapse notes'} title={notesCollapsed ? 'Expand notes' : 'Collapse notes'} aria-controls="notebook-notes" aria-expanded={!notesCollapsed} onClick={() => mobileViewport ? setMobileList(current => !current) : setLayout(current => ({ ...current, notesCollapsed: !current.notesCollapsed }))}>{notesCollapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}</button>}</div>
    <main className="editor-panel">
      {note ? <><div className="editor-topbar"><div className="note-location"><div className="mode-switch"><button className={mode === 'write' ? 'active' : ''} onClick={() => setMode('write')}><PenLine size={14} /> Write</button><button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}><BookOpen size={14} /> Preview</button></div></div>{mode === 'write' && <div className="formatting-toolbar" aria-label="Markdown formatting">{[{ icon: Bold, title: 'Bold', before: '**', after: '**' }, { icon: Italic, title: 'Italic', before: '_', after: '_' }, { icon: Heading2, title: 'Heading', before: '\n## ', after: '' }, { icon: List, title: 'List', before: '\n- ', after: '' }, { icon: Quote, title: 'Quote', before: '\n> ', after: '' }, { icon: Code2, title: 'Code', before: '`', after: '`' }, { icon: Link, title: 'Link', before: '[', after: '](https://)' }].map(item => <button key={item.title} className="icon-button" aria-label={item.title} title={item.title} disabled={locked} onClick={() => format(item.before, item.after)}><item.icon size={16} /></button>)}</div>}<div className="editor-actions">{session && <span className={`visibility-badge ${active.published ? 'public' : ''}`}>{active.published ? <Globe2 size={13} /> : <LockKeyhole size={13} />}{active.published ? 'Public copy' : 'Private'}</span>}{note.content === SAMPLE_MARKDOWN && <button className="icon-button" onClick={() => void copy(SAMPLE_MARKDOWN)} aria-label="Copy Markdown" title="Copy Markdown"><Copy size={16} /></button>}<button className="button ghost small" onClick={() => download(note)} aria-label="Export Markdown" title="Export Markdown"><ArrowDownToLine size={16} /></button><button className="button secondary small" onClick={() => setModal('share')} disabled={locked}><Globe2 size={14} /> Share</button><button className="icon-button" onClick={() => setModal('delete')} disabled={locked} aria-label="Delete note"><Trash2 size={16} /></button></div></div>
      <div className="editor-content"><input className="note-title-input" aria-label="Note title" placeholder="Untitled note" value={note.title} maxLength={200} disabled={locked} onChange={event => edit({ title: event.target.value })} />{mode === 'write' ? <textarea ref={editor} className="markdown-editor" aria-label="Markdown content" placeholder="Write a note…" value={note.content} disabled={locked} onChange={event => edit({ content: event.target.value })} spellCheck /> : <Markdown content={note.content} />}</div>
      <footer className="editor-bottom"><button className={`save-status ${status === 'Not saved' ? 'save-error' : ''}`} onClick={() => void flush().catch(error => notice(errorMessage(error), true))} title="Save changes">{status === 'Saving…' ? <LoaderCircle size={13} className="spin" /> : session ? <CheckCheck size={14} /> : <PenLine size={13} />}{status}</button><button className="folder-location" aria-label="Move note" title={`Move note · ${note.folder || 'Unfiled'}`} disabled={locked} onClick={() => { setFolderInput(note.folder || ''); setFolderError(''); setModal('move') }}><Folder size={13} /><span>{note.folder || 'Unfiled'}</span></button><span>{words} words</span></footer></> : initializing || loading ? <div className="empty-state editor-empty"><LoaderCircle className="spin" aria-label="Loading notes" /></div> : <><div className="editor-topbar"><div className="editor-actions"><button className="button ghost small" onClick={() => void copy(SAMPLE_MARKDOWN)}><Copy size={16} /> Copy Markdown</button><button className="button secondary small" onClick={() => void addNote()} disabled={locked}><Plus size={16} /> New note</button></div></div><div className="editor-content"><h1 className="note-title-input">Markdown basics</h1><textarea className="markdown-editor" aria-label="Sample Markdown" readOnly value={SAMPLE_MARKDOWN} /></div></>}
    </main>
    <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" ref={importer} hidden onChange={event => void importFile(event)} />
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}><span>{toast.message}</span><button className="icon-button" onClick={() => setToast(null)} aria-label="Dismiss notification"><X size={15} /></button></div>}
    {modal === 'auth' && <Modal title="Connect Pubky" close={closeModal}><p className="modal-intro">Sign in with your existing identity in <strong>Pubky Ring</strong>. Your keys stay in your wallet.</p>{qr ? <img className="qr-code" src={qr} alt="Scan with Pubky Ring to authorize this notebook" width={240} height={240} /> : !authError ? <div className="auth-loading"><LoaderCircle className="spin" /><p>Preparing your connection…</p></div> : null}{authUrl && <><a className="button primary auth-link" href={authUrl}>Open Pubky Ring <ExternalLink size={15} /></a><button className="button secondary auth-link" onClick={() => void copy(authUrl)}><Copy size={15} /> Copy authorization link</button><p className="auth-instructions">Scan the code in Ring, or open the link on your phone. Approve access to this app’s private and public note folders.</p></>}{authError && <p className="inline-error" role="alert">{authError}</p>}{(authError || authUrl) && <button className="button ghost small" disabled={authStarting} onClick={() => void connect()}>Generate a fresh link</button>}<p className="hint">{IS_TESTNET ? 'Local testnet' : 'Mainnet'} · Need an identity? <a href="https://pubky.org" target="_blank" rel="noreferrer">Get Pubky Ring</a>. Connecting replaces this temporary scratchpad with your saved notebook. Export anything you want to keep.</p></Modal>}
    {modal === 'share' && note && <Modal title="Share note" close={closeModal}>{!session ? <><p>Connect Pubky to save this note and publish a public copy. This scratchpad is only in this tab.</p><button className="button primary" onClick={() => void connect()}>Connect Pubky <ChevronRight size={15} /></button></> : <><div className="share-status"><span className={`visibility-badge ${active.published ? 'public' : ''}`}>{active.published ? <Globe2 size={14} /> : <LockKeyhole size={14} />}{active.published ? 'Public copy published' : 'Only in your private notebook'}</span></div><p>Your draft stays under <code>/priv</code>. Publishing puts a copy under <code>/pub</code>, where anyone can read, discover, and download it.</p>{active.published && <><label className="field-label" htmlFor="public-link">PUBLIC NOTE LINK</label><div className="copy-link"><input id="public-link" readOnly value={publicUrl(owner, note.id)} onFocus={event => event.target.select()} /><button className="icon-button" onClick={() => void copy(publicUrl(owner, note.id))} aria-label="Copy public note link"><Copy size={17} /></button></div><p className="hint">{publicChanged ? 'Your private draft has changes that are not public yet.' : 'Your public copy is up to date.'}</p></>}<p className="hint">Unpublishing removes the public copy from your homeserver. Copies already downloaded may remain elsewhere.</p><div className="modal-actions">{active.published && <button className="button secondary" disabled={busy} onClick={() => void sharing('unpublish')}>Unpublish</button>}<button className="button primary" disabled={busy || (!!active.published && !publicChanged)} onClick={() => void sharing('publish')}>{busy ? <LoaderCircle className="spin" size={15} /> : <Globe2 size={15} />}{active.published ? 'Update public copy' : 'Publish public copy'}</button></div></>}</Modal>}
    {modal === 'move' && note && <Modal title="Move note" close={closeModal}><form onSubmit={event => { event.preventDefault(); void moveNote() }}><label className="field-label" htmlFor="note-folder">Folder</label><input id="note-folder" list="note-folders" value={folderInput} onChange={event => { setFolderInput(event.target.value); setFolderError('') }} placeholder="Work/Project" maxLength={512} disabled={busy} aria-describedby="folder-hint" autoFocus /><datalist id="note-folders">{paths.map(path => <option key={path} value={path} />)}</datalist><p className="hint" id="folder-hint">Use / for nested folders. Leave empty for Unfiled.</p>{folderError && <p className="inline-error" role="alert">{folderError}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={closeModal} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}Move</button></div></form></Modal>}
    {modal === 'delete' && note && <Modal title="Delete this note?" close={closeModal}><p>“{note.title || 'Untitled note'}” will be permanently removed{active.published ? ', along with its public copy' : ''}. Export your Markdown first if you want to keep a copy.</p><div className="modal-actions"><button className="button secondary" onClick={closeModal}>Keep note</button><button className="button danger" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />Delete note</button></div></Modal>}
    {modal === 'help' && <Modal title="Help" close={closeModal}><div className="help-item"><LockKeyhole size={20} /><div><h3>Privacy</h3><p>Notes autosave to your Pubky homeserver under <code>/priv/notes/</code>. This restricts access, but is not end-to-end encryption: your homeserver operator can read the data.</p></div></div><div className="help-item"><Globe2 size={20} /><div><h3>Sharing</h3><p>Publish a public snapshot using Share. Later edits stay private until you choose Update public copy.</p></div></div><div className="help-item"><Code2 size={20} /><div><h3>Editing</h3><p>Write Markdown, preview as you go, and import or export <code>.md</code> files. Press Ctrl/⌘ + S to save immediately. Remote images are shown as text to protect reader privacy.</p></div></div><p className="hint">Keep one editing tab per notebook. Notes do not merge simultaneous edits from other devices. Private note bodies are not cached in browser storage.</p><a href="https://pubky.org/developer-guide.md" target="_blank" rel="noreferrer" className="button secondary small">Pubky documentation <ExternalLink size={14} /></a></Modal>}
  </div>
}
