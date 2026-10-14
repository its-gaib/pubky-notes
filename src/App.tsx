import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { Session } from '@synonymdev/pubky'
import QRCode from 'qrcode'
import { ArrowDownToLine, ArrowUpFromLine, BookOpen, CheckCheck, ChevronLeft, ChevronRight, CircleHelp, Code2, Copy, FileText, Folder, Globe2, Heading2, Link, List, LoaderCircle, LockKeyhole, PenLine, Plus, Search, RefreshCw, Trash2, X, MoreHorizontal, FolderPlus, Bold, Italic, Quote, ExternalLink, UsersRound } from 'lucide-react'
import Markdown from './components/Markdown'
import AccountProfile from './components/AccountProfile'
import { IS_TESTNET } from './config'
import { discardSession, persistSession, restoreSession, signOut, startSignIn } from './lib/pubky'
import type { AuthFlow } from './lib/pubky'
import { createNote, listNotes, loadPublicNote, publishNote, unpublishNote } from './lib/notes'
import type { Note, NoteRecord } from './lib/notes'
import { filterNotes, folderContains, folderLabel, folderPaths, normalizeFolder, renameFolderPath } from './lib/folders'
import { loadFolders, normalizeFolderPaths } from './lib/folder-store'
import { editNote, initializeNote, LineageConflictError, mergeNotes, noteRevision } from './lib/crdt'
import { adoptGuestNotebook, readLocalNotebook, resolveLocalNoteDestination, setLocalActiveId, writeLocalFolders, writeLocalNote } from './lib/local-notebook'
import type { LocalNotebook } from './lib/local-notebook'
import { GUEST_SCOPE, mergeRemoteNotebook, scopeForSession, synchronizeNotebook, uploadNotebook } from './lib/notebook-sync'
import { useCollaboration } from './hooks/useCollaboration'
import type { SharedNoteDocument } from './lib/shared-note'

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
const ACCOUNT_KEY = `pubky-notes:last-account:${IS_TESTNET ? 'testnet' : 'mainnet'}`
function rememberedScope() {
  try { const value = localStorage.getItem(ACCOUNT_KEY); return value?.startsWith(GUEST_SCOPE.split(':')[0] + ':') && /^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : GUEST_SCOPE } catch { return GUEST_SCOPE }
}
function savedLayout() {
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
    return { navigationCollapsed: value?.navigationCollapsed === true, notesCollapsed: value?.notesCollapsed === true }
  } catch { return { navigationCollapsed: false, notesCollapsed: false } }
}

function scratchpad(): NoteRecord {
  return { note: editNote(initializeNote(createNote()), { title: 'Markdown basics', content: SAMPLE_MARKDOWN }), published: null }
}
function errorMessage(error: unknown) {
  const name = error instanceof Error ? error.name : ''
  if (name === 'PkarrError') return `Could not find this identity on ${IS_TESTNET ? 'the local testnet' : 'mainnet'}. Check your network and Pubky Ring account.`
  if (name === 'AuthenticationError') return 'Your Pubky session needs attention. Reconnect your identity and try again.'
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}
function dateLabel(value: string) { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
function historyKey(scope: string, note: Note) { return JSON.stringify([scope, note.id, note.createdAt, note.crdt?.lineage]) }
function sameHistory(left: Note, right: Note) { return left.id === right.id && left.createdAt === right.createdAt && left.crdt?.lineage === right.crdt?.lineage }
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

function SidebarActions({ label, disabled, items }: { label: string; disabled: boolean; items: { label: string; disabled?: boolean; action: () => void }[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
      buttons[index]?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key) }
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <div className="sidebar-actions" ref={ref} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button ref={trigger} className="icon-button row-actions-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(current => !current)}><MoreHorizontal size={17} /></button>
    {open && <div className="sidebar-actions-menu" role="menu" aria-label={label} id={id}>{items.map(item => <button key={item.label} role="menuitem" disabled={item.disabled} onClick={() => { setOpen(false); item.action() }}>{item.label}</button>)}</div>}
  </div>
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
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'private' | 'public' | 'trash'>('all')
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [explicitFolders, setExplicitFolders] = useState<string[]>([])
  const [folderEditor, setFolderEditor] = useState<{ kind: 'create' | 'rename' | 'remove'; path: string }>({ kind: 'create', path: '' })
  const [moveTargetId, setMoveTargetId] = useState('')
  const [folderInput, setFolderInput] = useState('')
  const [folderError, setFolderError] = useState('')
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const [status, setStatus] = useState('Sample')
  const [scope, setScope] = useState(rememberedScope)
  const [needsSync, setNeedsSync] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null)
  const [modal, setModal] = useState<'auth' | 'share' | 'delete' | 'help' | 'move' | 'folder' | 'collaborate' | 'join' | null>(null)
  const [authUrl, setAuthUrl] = useState('')
  const [qr, setQr] = useState('')
  const [authError, setAuthError] = useState('')
  const [authStarting, setAuthStarting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileList, setMobileList] = useState(true)
  const [mobileViewport, setMobileViewport] = useState(() => window.matchMedia?.('(max-width: 700px)')?.matches ?? false)
  const [layout, setLayout] = useState(savedLayout)
  const recordsRef = useRef(records); recordsRef.current = records
  const foldersRef = useRef(explicitFolders); foldersRef.current = explicitFolders
  const busyRef = useRef(busy); busyRef.current = busy
  const sessionRef = useRef(session); sessionRef.current = session
  const renameAttempt = useRef<{ source: string; target: string } | null>(null)
  const scopeRef = useRef(scope); scopeRef.current = scope
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId
  const exampleId = useRef<string | null>(records[0]?.note.id ?? null)
  const dirtyLocal = useRef(new Map<string, { scope: string; record: NoteRecord }>())
  const dirtyFolders = useRef<{ scope: string; folders: string[] } | null>(null)
  const folderVersion = useRef(0)
  const localQueue = useRef<Promise<unknown>>(Promise.resolve())
  const syncJob = useRef<Promise<void> | null>(null)
  const lastBackground = useRef(0)
  const authFlow = useRef<AuthFlow | null>(null)
  const authEpoch = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const editor = useRef<HTMLTextAreaElement>(null)
  const titleEditor = useRef<HTMLInputElement>(null)
  const importer = useRef<HTMLInputElement>(null)
  const visibleRecords = records.filter(row => (row.note.deleted === true) === (filter === 'trash'))
  const active = visibleRecords.find(row => row.note.id === activeId) ?? visibleRecords[0]
  const note = active?.note
  const owner = session?.info.publicKey.z32() ?? (scope !== GUEST_SCOPE ? scope.split(':')[1] : '')
  const notice = useCallback((message: string, error = false) => setToast({ message, error }), [])
  const closeModal = useCallback(() => { if (busyRef.current) return; authEpoch.current++; authFlow.current?.cancel(); authFlow.current = null; setModal(null); setAuthStarting(false) }, [])

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

  const replaceRecords = useCallback((next: NoteRecord[]) => {
    const previous = recordsRef.current
    if (previous.length === next.length && previous.every((row, index) => {
      const other = next[index]
      return row.note.id === other.note.id && row.note.updatedAt === other.note.updatedAt && noteRevision(row.note) === noteRevision(other.note) && JSON.stringify(row.published) === JSON.stringify(other.published)
    })) return
    recordsRef.current = next; setRecords(next)
  }, [])
  const persistRecord = useCallback((record: NoteRecord, capturedScope = scopeRef.current): Promise<NoteRecord> => {
    const key = historyKey(capturedScope, record.note)
    const entry = { scope: capturedScope, record }
    dirtyLocal.current.set(key, entry)
    if (scopeRef.current === capturedScope) setNeedsSync(true)
    if (scopeRef.current === capturedScope) setStatus('Saving on this device…')
    const work = async () => {
      try {
        const saved = await writeLocalNote(capturedScope, record)
        const destination = capturedScope === GUEST_SCOPE ? await resolveLocalNoteDestination(capturedScope, record.note) : { scope: capturedScope, id: saved.note.id }
        if (destination.scope !== capturedScope) {
          // Another tab already claimed this guest history for one account. Keep
          // the old guest ID as its routing handle; account text/IDs must never
          // become new guest drafts that a later login could claim elsewhere.
          if (dirtyLocal.current.get(key) === entry) dirtyLocal.current.delete(key)
          if (scopeRef.current === capturedScope) setStatus(dirtyLocal.current.size || dirtyFolders.current ? 'Saving on this device…' : 'Saved on this device')
          return saved
        }
        if (saved.note.id !== record.note.id) {
          // The cache durably moved this exact history, possibly in another tab.
          // Carry later typing to that ID before releasing its old pending entry.
          const pending = dirtyLocal.current.get(key)
          const visible = scopeRef.current === capturedScope ? recordsRef.current.find(row => sameHistory(row.note, record.note)) : undefined
          let recovered = saved
          for (const latest of [pending?.record, visible]) {
            if (latest) recovered = { note: mergeNotes(recovered.note, { ...latest.note, id: saved.note.id }), published: null }
          }
          const targetKey = historyKey(capturedScope, recovered.note)
          const targetPending = dirtyLocal.current.get(targetKey)
          if (targetPending) recovered = { note: mergeNotes(recovered.note, targetPending.record.note), published: null }
          if (noteRevision(recovered.note) !== noteRevision(saved.note)) {
            void persistRecord(recovered, capturedScope).catch(error => { if (scopeRef.current === capturedScope) notice(errorMessage(error), true) })
          }
          if (dirtyLocal.current.get(key) === pending) dirtyLocal.current.delete(key)
          if (visible) {
            const target = recordsRef.current.find(row => sameHistory(row.note, recovered.note))
            if (target) recovered = { note: mergeNotes(recovered.note, target.note), published: null }
            replaceRecords([...recordsRef.current.filter(row => !sameHistory(row.note, record.note) && row.note.id !== recovered.note.id), recovered])
            if (activeIdRef.current === record.note.id) {
              activeIdRef.current = recovered.note.id; setActiveId(recovered.note.id)
              void setLocalActiveId(capturedScope, recovered.note.id).catch(error => notice(errorMessage(error), true))
            }
          }
        } else if (dirtyLocal.current.get(key) === entry) dirtyLocal.current.delete(key)
        if (scopeRef.current === capturedScope) {
          const current = recordsRef.current.find(row => row.note.id === saved.note.id)
          if (current && sameHistory(current.note, saved.note)) {
            const merged = mergeNotes(current.note, saved.note)
            if (noteRevision(current.note) !== noteRevision(merged)) replaceRecords(recordsRef.current.map(row => row.note.id === merged.id ? { ...row, note: merged } : row))
          }
          setStatus(dirtyLocal.current.size || dirtyFolders.current ? 'Saving on this device…' : 'Saved on this device')
        }
        return saved
      } catch (error) { if (scopeRef.current === capturedScope) setStatus('Not saved on this device'); throw error }
    }
    const pending = localQueue.current.then(work, work)
    localQueue.current = pending.catch(() => undefined)
    return pending
  }, [replaceRecords, notice])
  const persistFolders = useCallback((folders: string[], capturedScope = scopeRef.current): Promise<void> => {
    const entry = { scope: capturedScope, folders }
    dirtyFolders.current = entry
    if (scopeRef.current === capturedScope) folderVersion.current++
    if (scopeRef.current === capturedScope) setNeedsSync(true)
    if (scopeRef.current === capturedScope) setStatus('Saving on this device…')
    const work = async () => {
      await writeLocalFolders(capturedScope, folders)
      if (dirtyFolders.current === entry) dirtyFolders.current = null
      if (scopeRef.current === capturedScope) setStatus(dirtyLocal.current.size || dirtyFolders.current ? 'Saving on this device…' : 'Saved on this device')
    }
    const pending = localQueue.current.then(work, work)
    localQueue.current = pending.catch(() => undefined)
    return pending
  }, [])
  const persistCollaborativeNote = useCallback(async (incoming: Note, capturedScope: string, select = false) => {
    if (scopeRef.current !== capturedScope || !sessionRef.current) return
    const existing = recordsRef.current.find(row => row.note.id === incoming.id)
    if (existing && !sameHistory(existing.note, incoming)) throw new Error('A different note already uses this identifier. Your notes were retained.')
    const row: NoteRecord = { note: existing ? mergeNotes(existing.note, incoming) : incoming, published: existing?.published ?? null }
    replaceRecords([row, ...recordsRef.current.filter(item => item.note.id !== incoming.id && item.note.id !== exampleId.current)])
    exampleId.current = null
    if (select) {
      activeIdRef.current = row.note.id; setActiveId(row.note.id); setMode('write'); setQuery(''); setFilter('all'); setSelectedFolder(null); setMobileList(false)
    }
    await persistRecord(row, capturedScope)
    if (select && scopeRef.current === capturedScope) await setLocalActiveId(capturedScope, row.note.id)
  }, [persistRecord, replaceRecords])
  const beforeCollaborativeChange = useCallback((doc: SharedNoteDocument) => {
    if (activeIdRef.current !== doc.note.id) return
    const field = document.activeElement === editor.current ? 'content' : document.activeElement === titleEditor.current ? 'title' : null
    const element = field === 'content' ? editor.current : field === 'title' ? titleEditor.current : null
    if (!field || !element) return
    const selected = doc.captureSelection(field, element.selectionStart ?? 0, element.selectionEnd ?? 0)
    const capturedScope = scopeRef.current, capturedId = doc.note.id
    return () => {
      const selection = doc.resolveSelection(selected)
      if (selection) requestAnimationFrame(() => {
        if (scopeRef.current === capturedScope && activeIdRef.current === capturedId && document.activeElement === element) element.setSelectionRange(selection.start, selection.end)
      })
    }
  }, [])
  const collaboration = useCollaboration({ scope, enabled: !!session && !initializing, notes: records.map(row => row.note), activeId: note?.id,
    persist: persistCollaborativeNote, beforeRemoteChange: beforeCollaborativeChange })
  useEffect(() => { if (collaboration.invitation && !initializing) setModal('join') }, [collaboration.invitation, initializing, session])
  useEffect(() => { if (collaboration.view.request) setModal('collaborate') }, [collaboration.view.request])
  const flushLocal = useCallback(async () => {
    await localQueue.current
    for (const { scope: savedScope, record } of [...dirtyLocal.current.values()]) await persistRecord(record, savedScope)
    const pendingFolders = dirtyFolders.current
    if (pendingFolders) await persistFolders(pendingFolders.folders, pendingFolders.scope)
    await localQueue.current
  }, [persistRecord, persistFolders])
  const displayNotebook = useCallback((notebook: LocalNotebook, capturedScope: string, replace = false, preferredId?: string) => {
    if (scopeRef.current !== capturedScope) return
    const current = replace ? [] : recordsRef.current.filter(row => row.note.id !== exampleId.current)
    const snapshotRevisions = new Map(notebook.records.map(row => [row.note.id, noteRevision(row.note)]))
    const incoming = new Map(notebook.records.map(row => [row.note.id, row]))
    let recoveredActive: string | undefined
    for (const row of current) {
      const redirect = notebook.recoveries?.find(candidate => candidate.id === row.note.id && candidate.createdAt === row.note.createdAt && candidate.lineage === row.note.crdt?.lineage)
      const destinationId = redirect?.targetId ?? row.note.id
      const remote = incoming.get(destinationId)
      const local = destinationId === row.note.id ? row : { note: { ...row.note, id: destinationId }, published: null }
      if (remote && sameHistory(local.note, remote.note)) {
        const merged = { ...remote, note: mergeNotes(local.note, remote.note), ...(redirect ? { published: null } : {}) }
        incoming.set(destinationId, merged)
        if (redirect) {
          if (activeIdRef.current === row.note.id) recoveredActive = destinationId
          if (noteRevision(merged.note) !== noteRevision(remote.note)) void persistRecord(merged, capturedScope).catch(() => undefined)
        }
      } else {
        // A snapshot can race a recovery transaction. Let the cache resolve the
        // exact source identity instead of guessing another document's lineage.
        incoming.set(row.note.id, row)
        if (remote || redirect) void persistRecord(row, capturedScope).catch(() => undefined)
      }
    }
    let next = [...incoming.values()]
    if (!next.length && capturedScope === GUEST_SCOPE) {
      const sample = recordsRef.current.find(row => row.note.id === exampleId.current) ?? scratchpad()
      exampleId.current = sample.note.id; next = [sample]
    } else exampleId.current = null
    const focused = document.activeElement === editor.current
    const selection = focused && editor.current ? [editor.current.selectionStart, editor.current.selectionEnd] : null
    replaceRecords(next)
    if (JSON.stringify(foldersRef.current) !== JSON.stringify(notebook.folders)) { foldersRef.current = notebook.folders; setExplicitFolders(notebook.folders) }
    const selected = preferredId ?? recoveredActive ?? (replace ? notebook.activeId : activeIdRef.current) ?? ''
    const nextId = next.some(row => row.note.id === selected) ? selected : notebook.activeId || next.find(row => !row.note.deleted)?.note.id || ''
    activeIdRef.current = nextId; setActiveId(nextId)
    if (selection) requestAnimationFrame(() => editor.current?.setSelectionRange(selection[0], selection[1]))
    const newerLocalEdits = next.some(row => row.note.id !== exampleId.current && snapshotRevisions.get(row.note.id) !== noteRevision(row.note))
    setNeedsSync(newerLocalEdits || !!notebook.pending.length || notebook.foldersPending || !!dirtyLocal.current.size || !!dirtyFolders.current)
    setStatus(dirtyLocal.current.size || dirtyFolders.current ? 'Saving on this device…' :
      sessionRef.current && !newerLocalEdits && !notebook.pending.length && !notebook.foldersPending ? 'Saved to Pubky' : next[0]?.note.id === exampleId.current ? 'Sample' : 'Saved on this device')
  }, [replaceRecords, persistRecord])
  const sync = useCallback(async (pull = false, background = false) => {
    while (syncJob.current) {
      const previous = syncJob.current
      if (background) return previous
      await previous.catch(() => undefined)
      if (syncJob.current === previous) syncJob.current = null
    }
    const capturedSession = sessionRef.current, capturedScope = scopeRef.current, capturedFolderVersion = folderVersion.current
    if (!capturedSession) { await flushLocal(); return }
    if (background && Date.now() - lastBackground.current < 5000) return
    lastBackground.current = Date.now()
    const job = (async () => {
      try {
        await flushLocal()
        if (scopeRef.current === capturedScope) setStatus('Syncing…')
        const notebook = await (pull ? synchronizeNotebook(capturedSession, capturedScope) : uploadNotebook(capturedSession, capturedScope))
        displayNotebook(folderVersion.current === capturedFolderVersion ? notebook : { ...notebook, folders: foldersRef.current, foldersPending: true }, capturedScope)
      } catch (error) {
        if (scopeRef.current === capturedScope) {
          const cached = await readLocalNotebook(capturedScope).catch(() => null)
          if (cached) displayNotebook(folderVersion.current === capturedFolderVersion ? cached : { ...cached, folders: foldersRef.current, foldersPending: true }, capturedScope)
          setStatus(dirtyLocal.current.size || dirtyFolders.current ? 'Not saved on this device' : 'Saved on this device')
        }
        throw error
      }
    })()
    syncJob.current = job
    try { await job } finally { if (syncJob.current === job) syncJob.current = null }
  }, [flushLocal, displayNotebook])
  const flush = useCallback(async () => { clearTimeout(timer.current); await flushLocal(); await sync() }, [flushLocal, sync])

  useEffect(() => {
    let canceled = false
    void (async () => {
      const remembered = scopeRef.current
      try {
        const cached = await readLocalNotebook(remembered)
        if (canceled) return
        displayNotebook(cached, remembered, true)
        const saved = await restoreSession()
        if (canceled) return
        if (!saved) return
        const accountScope = scopeForSession(saved)
        let local = await readLocalNotebook(accountScope)
        if (remembered === GUEST_SCOPE) local = await adoptGuestNotebook(GUEST_SCOPE, accountScope)
        if (canceled) return
        scopeRef.current = accountScope; setScope(accountScope); sessionRef.current = saved; setSession(saved)
        try { localStorage.setItem(ACCOUNT_KEY, accountScope) } catch { /* Account isolation still uses the captured scope. */ }
        displayNotebook(local, accountScope, true)
        setInitializing(false)
        await sync(true)
      } catch (error) { if (!canceled) notice(`${errorMessage(error)} Your local notes are retained.`, true) }
      finally { if (!canceled) setInitializing(false) }
    })()
    return () => { canceled = true }
  }, [displayNotebook, notice, sync])
  useEffect(() => {
    if (initializing || busy || !session || !needsSync) return
    timer.current = setTimeout(() => { sync().catch(error => notice(`${errorMessage(error)} Changes remain on this device.`, true)) }, 900)
    return () => clearTimeout(timer.current)
  }, [records, explicitFolders, session, initializing, busy, needsSync, sync, notice])
  useEffect(() => {
    if (!session) return
    const update = () => { if (document.visibilityState !== 'hidden' && !busyRef.current) void sync(true, true).catch(() => undefined) }
    const interval = setInterval(update, 20_000)
    window.addEventListener('online', update); window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => { clearInterval(interval); window.removeEventListener('online', update); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update) }
  }, [session, sync])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirtyLocal.current.size || dirtyFolders.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  useEffect(() => { if (!toast || toast.error) return; const id = setTimeout(() => setToast(null), 4500); return () => clearTimeout(id) }, [toast])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); flush().catch(error => notice(`${errorMessage(error)} Local changes are retained.`, true)) } }
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut)
  }, [flush, notice])

  function edit(patch: Partial<Pick<Note, 'title' | 'content'>>) {
    if (!note || note.deleted || busy || initializing) return
    try {
      const next = collaboration.edit(note, patch)
      const row = { ...active!, note: next }
      if (exampleId.current === note.id) exampleId.current = null
      replaceRecords(recordsRef.current.map(current => current.note.id === next.id ? row : current))
      void persistRecord(row).catch(error => notice(errorMessage(error), true))
      void setLocalActiveId(scopeRef.current, next.id).catch(error => notice(errorMessage(error), true))
    } catch (error) { notice(errorMessage(error), true) }
  }
  async function addNote(imported?: { title: string; content: string }) {
    try {
      await flushLocal()
      const draft = editNote(initializeNote(createNote()), { content: SAMPLE_MARKDOWN, folder: selectedFolder || '', ...(imported ?? {}) })
      const row = { note: draft, published: null }
      replaceRecords([row, ...recordsRef.current.filter(existing => existing.note.id !== exampleId.current)]); exampleId.current = null
      activeIdRef.current = draft.id; setActiveId(draft.id); setMode('write'); setQuery(''); setFilter('all'); setMobileList(false); setMenuOpen(false)
      await persistRecord(row); await setLocalActiveId(scopeRef.current, draft.id)
    } catch (error) { notice(errorMessage(error), true) }
  }
  async function switchNote(id: string) {
    try { await flushLocal(); activeIdRef.current = id; setActiveId(id); setMobileList(false); await setLocalActiveId(scopeRef.current, id) } catch (error) { notice(errorMessage(error), true) }
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
  function openMove(id: string) {
    const target = recordsRef.current.find(row => row.note.id === id)?.note
    if (!target) return
    setMoveTargetId(id); setFolderInput(target.folder || ''); setFolderError(''); setModal('move')
  }
  function manageFolder(kind: 'create' | 'rename' | 'remove', path = '') {
    renameAttempt.current = null
    setFolderEditor({ kind, path }); setFolderInput(kind === 'rename' ? folderLabel(path) : ''); setFolderError(''); setModal('folder')
  }
  async function writeFolders(paths: readonly string[]) {
    const normalized = normalizeFolderPaths(paths)
    foldersRef.current = normalized; setExplicitFolders(normalized)
    await persistFolders(normalized)
  }
  async function applyChangedNote(changed: Note) {
    const previous = recordsRef.current.find(row => row.note.id === changed.id)
    if (!previous) throw new Error('This note is no longer available.')
    const record = { ...previous, note: changed }
    if (exampleId.current === changed.id) exampleId.current = null
    replaceRecords(recordsRef.current.map(row => row.note.id === changed.id ? record : row))
    await persistRecord(record)
  }
  function revealFolder(folder: string) {
    setCollapsedFolders(current => new Set([...current].filter(path => !folder.startsWith(`${path}/`))))
  }
  async function moveNote() {
    if (!moveTargetId || busy) return
    setFolderError('')
    let folder: string
    let nextFolders: string[]
    try {
      folder = normalizeFolder(folderInput)
      nextFolders = normalizeFolderPaths(folderPaths(recordsRef.current, [...foldersRef.current, folder]))
    } catch (error) { setFolderError(errorMessage(error)); return }
    setBusy(true)
    try {
      await flushLocal()
      const target = recordsRef.current.find(row => row.note.id === moveTargetId)?.note
      if (!target) throw new Error('This note is no longer available.')
      // Keep the source and destination folders even when their last note moves.
      await writeFolders(nextFolders)
      const moved = editNote(target, { folder })
      await applyChangedNote(moved)
      revealFolder(folder); setModal(null)
      notice(`Moved to ${folder || 'Unfiled'}.`)
    } catch (error) { setFolderError(errorMessage(error)) } finally { setBusy(false) }
  }
  async function changeFolder() {
    if (busy) return
    setFolderError('')
    const { kind, path } = folderEditor
    const currentPaths = folderPaths(recordsRef.current.filter(row => !row.note.deleted), foldersRef.current)
    let target = path
    let staged: string[] = []
    let finalFolders: string[] = []
    let movedNotes: Note[] = []
    try {
      if (kind === 'remove') {
        if (recordsRef.current.some(row => !row.note.deleted && folderContains(path, row.note.folder || ''))) throw new Error('Move the notes out of this folder and its subfolders first.')
        finalFolders = normalizeFolderPaths(currentPaths.filter(folder => !folderContains(path, folder)))
      } else {
        if (!folderInput.trim() || folderInput.includes('/')) throw new Error('Enter one folder name. Use New subfolder to add another level.')
        const name = normalizeFolder(folderInput)
        const parent = kind === 'create' ? path : path.split('/').slice(0, -1).join('/')
        target = normalizeFolder([parent, name].filter(Boolean).join('/'))
        if (kind === 'rename' && target === path) { setModal(null); return }
        if (currentPaths.includes(target) && !(kind === 'rename' && renameAttempt.current?.source === path && renameAttempt.current.target === target)) throw new Error('A folder with that name already exists here.')
        if (kind === 'create') finalFolders = normalizeFolderPaths([...currentPaths, target])
        else {
          // Validate every descendant before the first write, including depth and length limits.
          const renamedPaths = currentPaths.map(folder => renameFolderPath(folder, path, target))
          finalFolders = normalizeFolderPaths(renamedPaths)
          staged = normalizeFolderPaths([...currentPaths, ...renamedPaths])
          movedNotes = recordsRef.current.filter(row => folderContains(path, row.note.folder || '')).map(row => editNote(row.note, { folder: renameFolderPath(row.note.folder || '', path, target) }))
        }
      }
    } catch (error) { setFolderError(errorMessage(error)); return }
    setBusy(true)
    try {
      await flushLocal()
      if (kind === 'rename') {
        // Registry staging makes a partially completed rename discoverable and retryable.
        await writeFolders(staged)
        renameAttempt.current = { source: path, target }
        for (const moved of movedNotes) {
          await applyChangedNote(moved)
        }
      }
      await writeFolders(finalFolders)
      if (kind === 'remove') {
        if (selectedFolder && folderContains(path, selectedFolder)) setSelectedFolder(null)
      } else {
        revealFolder(target)
        if (kind === 'create') { setSelectedFolder(target); setFilter('all'); setQuery(''); setMobileList(true) }
        else if (selectedFolder && folderContains(path, selectedFolder)) setSelectedFolder(renameFolderPath(selectedFolder, path, target))
      }
      renameAttempt.current = null; setModal(null)
    } catch (error) {
      setFolderError(kind === 'rename' ? `Rename stopped: ${errorMessage(error)} Completed moves have been kept; the sidebar shows the current folders.` : errorMessage(error))
    } finally { setBusy(false) }
  }
  async function connect() {
    setModal('auth'); setAuthStarting(true); setAuthError(''); setAuthUrl(''); setQr('')
    const epoch = ++authEpoch.current
    authFlow.current?.cancel()
    let candidate: Session | null = null
    let storedId: string | undefined
    let committing = false
    try {
      await flushLocal()
      const flow = await startSignIn()
      if (epoch !== authEpoch.current) { flow.cancel(); void flow.awaitApproval.catch(() => {}); return }
      authFlow.current = flow; setAuthUrl(flow.authorizationUrl); setAuthStarting(false)
      void QRCode.toDataURL(flow.authorizationUrl, { width: 240, margin: 2, color: { dark: '#252a40', light: '#ffffff' } }).then(value => { if (epoch === authEpoch.current) setQr(value) })
      const signedIn = await flow.awaitApproval
      candidate = signedIn
      if (epoch !== authEpoch.current) { await discardSession(signedIn); candidate = null; return }
      setAuthStarting(true)
      const [loaded, folders] = await Promise.all([listNotes(signedIn), loadFolders(signedIn)])
      if (epoch !== authEpoch.current) { await discardSession(signedIn); candidate = null; return }
      await flushLocal()
      storedId = await persistSession(signedIn)
      if (epoch !== authEpoch.current) { await discardSession(signedIn, storedId); candidate = null; return }
      // Claiming guest drafts is one account transition; it cannot be canceled halfway.
      committing = true; busyRef.current = true; setBusy(true)
      const accountScope = scopeForSession(signedIn)
      const previousScope = scopeRef.current, previousActive = activeIdRef.current || note?.id || ''
      await mergeRemoteNotebook(accountScope, loaded, folders)
      const adopted = previousScope === GUEST_SCOPE ? await adoptGuestNotebook(GUEST_SCOPE, accountScope) : await readLocalNotebook(accountScope)
      scopeRef.current = accountScope; setScope(accountScope); sessionRef.current = signedIn; setSession(signedIn)
      try { localStorage.setItem(ACCOUNT_KEY, accountScope) } catch { /* Account cache remains scoped in IndexedDB. */ }
      const preferred = previousScope === GUEST_SCOPE && 'idMap' in adopted ? (adopted.idMap as Record<string, string>)[previousActive] : previousScope === accountScope ? previousActive : undefined
      displayNotebook(adopted, accountScope, true, preferred)
      candidate = null
      committing = false; busyRef.current = false; setBusy(false)
      setModal(null); setAuthStarting(false); setQuery(''); setFilter('all'); setSelectedFolder(null); setCollapsedFolders(new Set())
      notice('Connected. Local drafts are syncing privately.')
      void navigator.storage?.persist?.().catch(() => undefined)
      await sync()
    } catch (error) {
      if (candidate) await discardSession(candidate, storedId).catch(() => undefined)
      if (epoch === authEpoch.current) {
        if (sessionRef.current) notice(`${errorMessage(error)} Your local notes are retained.`, true)
        else setAuthError(errorMessage(error))
        setAuthStarting(false)
      }
    } finally { if (committing && epoch === authEpoch.current) { busyRef.current = false; setBusy(false) } }
  }
  async function disconnect() {
    setBusy(true)
    try {
      collaboration.stop()
      await flushLocal()
      const existing = sessionRef.current
      if (syncJob.current) await syncJob.current.catch(() => undefined)
      const guest = await readLocalNotebook(GUEST_SCOPE)
      if (existing) await signOut(existing)
      sessionRef.current = null; setSession(null); scopeRef.current = GUEST_SCOPE; setScope(GUEST_SCOPE)
      try { localStorage.removeItem(ACCOUNT_KEY) } catch { /* The in-memory account has still been cleared. */ }
      displayNotebook(guest, GUEST_SCOPE, true)
      setMode('write'); setSelectedFolder(null); setCollapsedFolders(new Set()); setQuery(''); setFilter('all')
      notice('Disconnected. Your account notes remain saved on this device.')
    } catch (error) { notice(errorMessage(error), true) } finally { setBusy(false) }
  }
  async function sharing(action: 'publish' | 'unpublish') {
    if (!session || !note || note.deleted) return
    const capturedSession = session, capturedScope = scopeRef.current, reviewed = note
    setBusy(true)
    try {
      await flushLocal()
      if (syncJob.current) await syncJob.current.catch(() => undefined)
      if (action === 'publish') {
        // Resolve replacements before publishing, while retaining exactly the
        // text the user reviewed. A recovered ID needs a fresh publish action.
        await sync(true)
        await flushLocal()
        const destination = await resolveLocalNoteDestination(capturedScope, reviewed)
        if (destination.scope !== capturedScope || destination.id !== reviewed.id) {
          setModal(null)
          notice('This note has a different history on Pubky. Both versions are kept privately. Review the recovered note and choose Share again to publish it.', true)
          return
        }
        const published = await publishNote(capturedSession, reviewed)
        const existing = recordsRef.current.find(row => row.note.id === reviewed.id)
        if (existing && sameHistory(existing.note, reviewed) && scopeRef.current === capturedScope) {
          const updated = { ...existing, published }
          replaceRecords(recordsRef.current.map(row => row.note.id === reviewed.id ? updated : row))
          await persistRecord(updated, capturedScope)
        }
        notice('Public copy published.')
      } else {
        await unpublishNote(capturedSession, reviewed.id)
        const existing = recordsRef.current.find(row => row.note.id === reviewed.id)
        if (existing && scopeRef.current === capturedScope) {
          const updated = { ...existing, published: null }
          replaceRecords(recordsRef.current.map(row => row.note.id === reviewed.id ? updated : row))
          await persistRecord(updated, capturedScope)
        }
        notice('Public copy removed.')
      }
      await sync(true)
    } catch (error) {
      if (action === 'publish' && error instanceof LineageConflictError) {
        try {
          // The remote history may have changed after the first refresh. Recover
          // privately, without retrying publication against a new target.
          await sync(true)
          await flushLocal()
          setModal(null)
          notice('The note changed to a different history before publishing. Both versions are kept privately. Review the recovered note and choose Share again to publish it.', true)
        } catch (recoveryError) { notice(`${errorMessage(recoveryError)} Publishing stopped. Your local text is retained.`, true) }
      } else notice(errorMessage(error), true)
    } finally { setBusy(false) }
  }
  async function remove() {
    if (!note) return
    setBusy(true)
    try {
      await flushLocal()
      if (note.id === exampleId.current) {
        exampleId.current = null; replaceRecords(recordsRef.current.filter(row => row.note.id !== note.id))
      } else await applyChangedNote(editNote(note, { deleted: true }))
      activeIdRef.current = ''; setActiveId(''); setModal(null)
      notice(active?.published ? 'Moved to Trash. The public copy is removed when synchronization succeeds.' : 'Moved to Trash.')
    } catch (error) { notice(errorMessage(error), true) } finally { setBusy(false) }
  }
  async function restoreNote(id: string) {
    const target = recordsRef.current.find(row => row.note.id === id)?.note
    if (!target?.deleted) return
    setBusy(true)
    try {
      await flushLocal(); await applyChangedNote(editNote(target, { deleted: false }))
      setFilter('all'); setSelectedFolder(null); activeIdRef.current = id; setActiveId(id)
      await setLocalActiveId(scopeRef.current, id); notice('Note restored.')
    } catch (error) { notice(errorMessage(error), true) } finally { setBusy(false) }
  }
  async function refresh() {
    try { await sync(true); notice('Notebook synchronized.') } catch (error) { notice(`${errorMessage(error)} Local notes are retained.`, true) }
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
  const paths = folderPaths(records.filter(row => !row.note.deleted), explicitFolders)
  const moveTarget = records.find(row => row.note.id === moveTargetId)?.note
  const searching = !!query.trim()
  const filtered = filterNotes(visibleRecords, query, filter === 'trash' ? 'all' : filter, selectedFolder).sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt))
  const listTitle = filter === 'trash' ? 'Trash' : searching ? 'Search results' : selectedFolder !== null ? folderLabel(selectedFolder) || 'Unfiled' : filter === 'all' ? 'All notes' : filter === 'private' ? 'Private notes' : 'Public notes'
  const words = note?.content.trim().split(/\s+/).filter(Boolean).length ?? 0
  const publicChanged = active?.published && (active.published.content !== note?.content || active.published.title !== note?.title)
  const locked = busy || initializing
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
      <nav className="nav-group" aria-label="Notebook filters">{([{ key: 'all', label: 'All notes', icon: FileText }, { key: 'private', label: 'Private', icon: LockKeyhole }, { key: 'public', label: 'Public', icon: Globe2 }, { key: 'trash', label: 'Trash', icon: Trash2 }] as const).map(item => <button key={item.key} className={`nav-item ${selectedFolder === null && filter === item.key ? 'active' : ''}`} onClick={() => { setFilter(item.key); setSelectedFolder(null); setQuery(''); setMobileList(true); setMenuOpen(false) }}><item.icon size={17} /><span>{item.label}</span></button>)}</nav>
      <div className="folder-section">
        <button className="nav-item new-folder-button" disabled={locked} onClick={() => manageFolder('create')}><FolderPlus size={17} /><span>New folder</span></button>
        <button className={`nav-item folder-root ${selectedFolder === '' ? 'active' : ''}`} onClick={() => openFolder('')}><Folder size={17} /><span>Unfiled</span></button>
        <nav className="folder-tree" aria-label="Folders">{paths.map(path => {
          const segments = path.split('/')
          if (segments.some((_, index) => index > 0 && collapsedFolders.has(segments.slice(0, index).join('/')))) return null
          const hasChildren = paths.some(other => other.startsWith(`${path}/`))
          return <div className="folder-entry" key={path}><div className="folder-row" style={{ paddingLeft: Math.min(30, (segments.length - 1) * 8) }}>
            {hasChildren ? <button className="folder-toggle" aria-label={`${collapsedFolders.has(path) ? 'Expand' : 'Collapse'} folder ${path}`} aria-expanded={!collapsedFolders.has(path)} onClick={() => toggleFolder(path)}><ChevronRight size={13} style={{ transform: collapsedFolders.has(path) ? undefined : 'rotate(90deg)' }} /></button> : <span className="folder-toggle" />}
            <button className={`folder-select ${selectedFolder === path ? 'active' : ''}`} aria-label={`Open folder ${path}`} title={path} onClick={() => openFolder(path)}><Folder size={15} /><span>{folderLabel(path)}</span></button>
          </div><SidebarActions label={`Folder actions for ${path}`} disabled={locked} items={[
            { label: 'New subfolder', action: () => manageFolder('create', path) },
            { label: 'Rename', action: () => manageFolder('rename', path) },
            { label: 'Remove empty folder', disabled: records.some(row => !row.note.deleted && folderContains(path, row.note.folder || '')), action: () => manageFolder('remove', path) },
          ]} /></div>
        })}</nav>
      </div>
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={() => importer.current?.click()} disabled={locked}><ArrowUpFromLine size={16} /><span>Import Markdown</span></button>
        <button className="nav-item" onClick={() => setModal('help')}><CircleHelp size={16} /><span>Help</span></button>
        {!session && <button className="button primary sidebar-connect" onClick={() => void connect()} disabled={initializing || authStarting} aria-busy={initializing}>Connect Pubky</button>}
        {owner && <AccountProfile owner={owner} disabled={locked} copy={copy} disconnect={() => void disconnect()} />}
        {IS_TESTNET && <span className="network-label">Local testnet</span>}
        <footer className="repository-links"><a href="https://github.com/its-gaib/pubky-notes" target="_blank" rel="noopener noreferrer" title="Pubky Notes on GitHub">GitHub</a><span aria-hidden="true">·</span><a href="https://github.com/its-gaib/pubky-notes-cli" target="_blank" rel="noopener noreferrer" title="Pubky Notes CLI on GitHub">CLI</a></footer>
      </div>
    </aside>{bothCollapsed ? <button className="pane-toggle navigation-edge" aria-label="Expand sidebars" title="Expand sidebars" aria-controls="notebook-navigation notebook-notes" aria-expanded={false} onClick={expandSidebars}><ChevronRight size={17} /></button> : <button className="pane-toggle navigation-edge" aria-label={navigationCollapsed ? 'Expand navigation' : 'Collapse navigation'} title={navigationCollapsed ? 'Expand navigation' : 'Collapse navigation'} aria-controls="notebook-navigation" aria-expanded={!navigationCollapsed} onClick={() => mobileViewport ? setMenuOpen(current => !current) : setLayout(current => ({ ...current, navigationCollapsed: !current.navigationCollapsed }))}>{navigationCollapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}</button>}</div>
    <div className="notes-pane"><section className="notes-panel" id="notebook-notes" aria-label="Notes">
      <div className="notes-header"><h2 title={selectedFolder || undefined}><span className="notes-heading-label">{listTitle}</span><span className="count">{filtered.length}</span></h2><div className="notes-header-actions">{session && <button className="icon-button" aria-label="Refresh notes" title="Refresh notes" disabled={locked} onClick={() => void refresh()}><RefreshCw size={16} /></button>}<button className="icon-button" aria-label="Create a new note" disabled={locked} onClick={() => void addNote()}><PenLine size={18} /></button></div></div>
      <div className="search-box"><Search size={16} /><input type="search" placeholder="Search all notes…" aria-label="Search all notes" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button search-clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}</div>
      <div className="note-list">{filtered.map(row => <div key={row.note.id} className={`note-card note-entry ${row.note.id === note?.id ? 'selected' : ''}`}><button className="note-select" aria-label={`Open note ${row.note.title || 'Untitled note'}`} onClick={() => void switchNote(row.note.id)} disabled={locked}><div className="note-card-title"><FileText size={15} /><strong>{row.note.title || 'Untitled note'}</strong>{row.note.crdt?.version === 2 && <UsersRound size={13} aria-label="Collaborative note" />}{row.published ? <Globe2 size={13} /> : <LockKeyhole size={13} />}</div><p className="note-card-excerpt">{row.note.content.replace(/[#*>`_\[\]]/g, '').trim().slice(0, 115)}</p><div className="note-card-meta"><span>{dateLabel(row.note.updatedAt)}</span><span className="folder-path" title={row.note.folder || 'Unfiled'}><Folder size={11} /><span>{row.note.folder || 'Unfiled'}</span></span></div></button><SidebarActions label={`Note actions for ${row.note.title || 'Untitled note'}`} disabled={locked} items={row.note.deleted ? [{ label: 'Restore', action: () => void restoreNote(row.note.id) }] : [{ label: 'Move to…', action: () => openMove(row.note.id) }]} /></div>)}{!visibleRecords.length && filter !== 'trash' && !initializing && <button className="note-card selected" onClick={() => setMobileList(false)}><div className="note-card-title"><Code2 size={15} /><strong>Markdown basics</strong></div><div className="note-card-meta">Sample</div></button>}{!filtered.length && (records.length > 0 || filter === 'trash') && <div className="empty-state"><Search size={25} /><p>{filter === 'trash' ? 'Trash is empty.' : searching ? 'No notes match your search.' : 'No notes.'}</p><button className="button ghost small" onClick={() => { if (searching || filter !== 'all' || selectedFolder !== null) { setQuery(''); setFilter('all'); setSelectedFolder(null) } else void addNote() }}> {searching || filter !== 'all' || selectedFolder !== null ? 'Show all notes' : 'New note'}</button></div>}</div>
    </section>{!bothCollapsed && <button className="pane-toggle notes-edge" aria-label={notesCollapsed ? 'Expand notes' : 'Collapse notes'} title={notesCollapsed ? 'Expand notes' : 'Collapse notes'} aria-controls="notebook-notes" aria-expanded={!notesCollapsed} onClick={() => mobileViewport ? setMobileList(current => !current) : setLayout(current => ({ ...current, notesCollapsed: !current.notesCollapsed }))}>{notesCollapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}</button>}</div>
    <main className="editor-panel">
      {note ? <><div className="editor-topbar"><div className="note-location"><div className="mode-switch"><button className={mode === 'write' ? 'active' : ''} onClick={() => setMode('write')}><PenLine size={14} /> Write</button><button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}><BookOpen size={14} /> Preview</button></div></div>{mode === 'write' && <div className="formatting-toolbar" aria-label="Markdown formatting">{[{ icon: Bold, title: 'Bold', before: '**', after: '**' }, { icon: Italic, title: 'Italic', before: '_', after: '_' }, { icon: Heading2, title: 'Heading', before: '\n## ', after: '' }, { icon: List, title: 'List', before: '\n- ', after: '' }, { icon: Quote, title: 'Quote', before: '\n> ', after: '' }, { icon: Code2, title: 'Code', before: '`', after: '`' }, { icon: Link, title: 'Link', before: '[', after: '](https://)' }].map(item => <button key={item.title} className="icon-button" aria-label={item.title} title={item.title} disabled={locked || note.deleted} onClick={() => format(item.before, item.after)}><item.icon size={16} /></button>)}</div>}<div className="editor-actions">{session && <span className={`visibility-badge ${active.published ? 'public' : ''}`}>{active.published ? <Globe2 size={13} /> : <LockKeyhole size={13} />}{active.published ? 'Public copy' : 'Private'}</span>}{note.content === SAMPLE_MARKDOWN && <button className="icon-button" onClick={() => void copy(SAMPLE_MARKDOWN)} aria-label="Copy Markdown" title="Copy Markdown"><Copy size={16} /></button>}<button className="button ghost small" onClick={() => download(note)} aria-label="Export Markdown" title="Export Markdown"><ArrowDownToLine size={16} /></button>{note.deleted && <button className="button secondary small" disabled={locked} onClick={() => void restoreNote(note.id)}>Restore</button>}<button className="button secondary small collaboration-button" onClick={() => setModal('collaborate')} disabled={locked || note.deleted} aria-label="Collaborate"><UsersRound size={15} /><span>Collaborate</span></button><button className="button secondary small" onClick={() => setModal('share')} disabled={locked || note.deleted}><Globe2 size={14} /> Share</button><button className="icon-button" onClick={() => setModal('delete')} disabled={locked || note.deleted} aria-label="Delete note"><Trash2 size={16} /></button></div></div>
      <div className="editor-content"><input ref={titleEditor} className="note-title-input" aria-label="Note title" placeholder="Untitled note" value={note.title} maxLength={200} disabled={locked || note.deleted} onChange={event => edit({ title: event.target.value })} />{mode === 'write' ? <textarea ref={editor} className="markdown-editor" aria-label="Markdown content" placeholder="Write a note…" value={note.content} disabled={locked || note.deleted} onChange={event => edit({ content: event.target.value })} spellCheck /> : <Markdown content={note.content} />}</div>
      <footer className="editor-bottom"><button className={`save-status ${status === 'Not saved on this device' ? 'save-error' : ''}`} onClick={() => void flush().catch(error => notice(errorMessage(error), true))} title="Save changes">{status === 'Saving on this device…' || status === 'Syncing…' ? <LoaderCircle size={13} className="spin" /> : session ? <CheckCheck size={14} /> : <PenLine size={13} />}{status}</button>{collaboration.view.noteId && <button className="collaboration-status" onClick={() => setModal('collaborate')}><UsersRound size={13} />{collaboration.view.status?.state === 'connected' ? collaboration.view.peerReceived ? 'Peer received' : 'Connected' : collaboration.view.status?.state === 'approval' ? 'Approval needed' : collaboration.view.status?.state === 'waiting' ? 'Waiting for collaborator' : 'Collaborator offline'}</button>}<span>{words} words</span></footer></> : initializing ? <div className="empty-state editor-empty"><LoaderCircle className="spin" aria-label="Loading notes" /></div> : <><div className="editor-topbar"><div className="editor-actions"><button className="button ghost small" onClick={() => void copy(SAMPLE_MARKDOWN)}><Copy size={16} /> Copy Markdown</button><button className="button secondary small" onClick={() => void addNote()} disabled={locked}><Plus size={16} /> New note</button></div></div><div className="editor-content"><h1 className="note-title-input">Markdown basics</h1><textarea className="markdown-editor" aria-label="Sample Markdown" readOnly value={SAMPLE_MARKDOWN} /></div></>}
    </main>
    <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" ref={importer} hidden onChange={event => void importFile(event)} />
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}><span>{toast.message}</span><button className="icon-button" onClick={() => setToast(null)} aria-label="Dismiss notification"><X size={15} /></button></div>}
    {modal === 'join' && collaboration.invitation && <Modal title="Join collaboration" close={() => { collaboration.dismissInvitation(); closeModal() }}>
      <p>Join this note as an editor. Your copy saves privately to your own Pubky homeserver.</p>
      <p className="hint">The inviter approves your connection. Both browsers need to be online to exchange changes.</p>
      {collaboration.view.error && <p className="inline-error" role="alert">{collaboration.view.error}</p>}
      <div className="modal-actions"><button className="button secondary" onClick={() => { collaboration.dismissInvitation(); closeModal() }}>Cancel</button>{session
        ? <button className="button primary" disabled={collaboration.view.working} onClick={() => void collaboration.join().then(() => setModal('collaborate')).catch(error => notice(errorMessage(error), true))}>Join collaboration</button>
        : <button className="button primary" onClick={() => void connect()}>Connect Pubky to join</button>}</div>
    </Modal>}
    {modal === 'collaborate' && <Modal title="Collaborate" close={closeModal}>
      {collaboration.view.noteId ? <>
        <p className="collaboration-note-name">{records.find(row => row.note.id === collaboration.view.noteId)?.note.title || 'Shared note'}</p>
        <p role="status">{collaboration.view.status?.state === 'connected' ? 'Connected. Changes are exchanged live.' : collaboration.view.status?.state === 'approval' ? 'Waiting for approval.' : collaboration.view.status?.state === 'waiting' ? 'Waiting for your collaborator.' : collaboration.view.status?.state === 'connecting' ? 'Connecting…' : 'Disconnected. Your edits remain saved locally.'}</p>
        {collaboration.view.link && <><label className="field-label" htmlFor="collaboration-link">Invitation link</label><div className="copy-link"><input id="collaboration-link" readOnly value={collaboration.view.link} onFocus={event => event.target.select()} /><button className="icon-button" aria-label="Copy invitation link" onClick={() => void copy(collaboration.view.link!)}><Copy size={17} /></button></div></>}
        {collaboration.view.request && <div className="collaboration-request"><p>A collaborator wants to join.</p><p className="hint">Connection code: <strong>{collaboration.view.request.fingerprint}</strong>. Compare it with the person you invited. This code identifies their browser, not a verified Pubky profile.</p><div className="modal-actions"><button className="button secondary" onClick={collaboration.reject}>Reject</button><button className="button primary" onClick={() => void collaboration.approve().catch(error => notice(errorMessage(error), true))}>Allow collaborator</button></div></div>}
        {collaboration.view.role === 'guest' && collaboration.view.ownFingerprint && <p className="hint">Your connection code: <strong>{collaboration.view.ownFingerprint}</strong>. The inviter can compare this before approving.</p>}
        {collaboration.view.error && <p className="inline-error" role="alert">{collaboration.view.error}</p>}
        {collaboration.view.status && !collaboration.view.status.relayAvailable && <p className="hint">Direct connections only: a relay is currently unavailable.</p>}
        <p className="hint">Each person keeps a private copy. Folders and Trash affect only your own notebook. Changes catch up when both browsers reconnect.</p>
        <div className="modal-actions"><button className="button secondary" onClick={() => { collaboration.stop(); closeModal() }}>Disconnect collaboration</button>{collaboration.view.status?.state !== 'connected' && <button className="button secondary" onClick={collaboration.reconnect}>Reconnect</button>}<button className="button primary" onClick={closeModal}>Done</button></div>
      </> : <>
        <p>{note?.crdt?.version === 2 ? 'Reconnect this shared note. Your private copy stays in your notebook.' : 'Create a shared copy of this note’s current text. Your original note stays private and unchanged.'}</p>
        <p className="hint">Invite one person to edit together. Both browsers need to be online to exchange changes; each saves a private copy to its own homeserver.</p>
        {collaboration.view.error && <p className="inline-error" role="alert">{collaboration.view.error}</p>}
        <div className="modal-actions"><button className="button secondary" onClick={closeModal}>Cancel</button>{session && note
          ? <button className="button primary" disabled={locked || collaboration.view.working} onClick={() => void flushLocal().then(() => collaboration.start(note)).catch(error => notice(errorMessage(error), true))}>{collaboration.view.working ? 'Preparing…' : note.crdt?.version === 2 ? 'Resume collaboration' : 'Create shared copy'}</button>
          : <button className="button primary" onClick={() => void connect()}>Connect Pubky</button>}</div>
      </>}
    </Modal>}
    {modal === 'auth' && <Modal title="Connect Pubky" close={closeModal}><p className="modal-intro">Sign in with your existing identity in <strong>Pubky Ring</strong>. Your keys stay in your wallet.</p>{qr ? <img className="qr-code" src={qr} alt="Scan with Pubky Ring to authorize this notebook" width={240} height={240} /> : !authError ? <div className="auth-loading"><LoaderCircle className="spin" /><p>Preparing your connection…</p></div> : null}{authUrl && <><a className="button primary auth-link" href={authUrl}>Open Pubky Ring <ExternalLink size={15} /></a><button className="button secondary auth-link" onClick={() => void copy(authUrl)}><Copy size={15} /> Copy authorization link</button><p className="auth-instructions">Scan the code in Ring, or open the link on your phone. Approve access to this app’s private and public note folders.</p></>}{authError && <p className="inline-error" role="alert">{authError}</p>}{(authError || authUrl) && <button className="button ghost small" disabled={authStarting} onClick={() => void connect()}>Generate a fresh link</button>}<p className="hint">{IS_TESTNET ? 'Local testnet' : 'Mainnet'} · Need an identity? <a href="https://pubky.org" target="_blank" rel="noreferrer">Get Pubky Ring</a>. Your local drafts will join your saved notes and upload privately after login.</p></Modal>}
    {modal === 'share' && note && <Modal title="Share note" close={closeModal}>{!session ? <><p>Connect Pubky to save this note and publish a public copy. Local drafts are saved on this device and upload privately after login.</p><button className="button primary" onClick={() => void connect()}>Connect Pubky <ChevronRight size={15} /></button></> : <><div className="share-status"><span className={`visibility-badge ${active.published ? 'public' : ''}`}>{active.published ? <Globe2 size={14} /> : <LockKeyhole size={14} />}{active.published ? 'Public copy published' : 'Only in your private notebook'}</span></div><p>Your draft stays under <code>/priv</code>. Publishing puts a copy under <code>/pub</code>, where anyone can read, discover, and download it.</p>{active.published && <><label className="field-label" htmlFor="public-link">PUBLIC NOTE LINK</label><div className="copy-link"><input id="public-link" readOnly value={publicUrl(owner, note.id)} onFocus={event => event.target.select()} /><button className="icon-button" onClick={() => void copy(publicUrl(owner, note.id))} aria-label="Copy public note link"><Copy size={17} /></button></div><p className="hint">{publicChanged ? 'Your private draft has changes that are not public yet.' : 'Your public copy is up to date.'}</p></>}<p className="hint">Unpublishing removes the public copy from your homeserver. Copies already downloaded may remain elsewhere.</p><div className="modal-actions">{active.published && <button className="button secondary" disabled={busy} onClick={() => void sharing('unpublish')}>Unpublish</button>}<button className="button primary" disabled={busy || (!!active.published && !publicChanged)} onClick={() => void sharing('publish')}>{busy ? <LoaderCircle className="spin" size={15} /> : <Globe2 size={15} />}{active.published ? 'Update public copy' : 'Publish public copy'}</button></div></>}</Modal>}
    {modal === 'move' && moveTarget && <Modal title="Move note" close={closeModal}><form onSubmit={event => { event.preventDefault(); void moveNote() }}><p className="move-note-name">{moveTarget.title || 'Untitled note'}</p><label className="field-label" htmlFor="move-destination">Move to</label><select id="move-destination" value={paths.includes(folderInput) || !folderInput ? folderInput : '__new__'} disabled={busy} onChange={event => { if (event.target.value !== '__new__') setFolderInput(event.target.value); else setFolderInput('New folder'); setFolderError('') }}><option value="">Unfiled</option>{paths.map(path => <option key={path} value={path}>{path}</option>)}<option value="__new__">New folder…</option></select><label className="field-label" htmlFor="note-folder">Folder path</label><input id="note-folder" value={folderInput} onChange={event => { setFolderInput(event.target.value); setFolderError('') }} placeholder="Unfiled" maxLength={512} disabled={busy} aria-describedby="folder-hint" /><p className="hint" id="folder-hint">Choose a folder above, or type a new path such as Work/Ideas. Leave empty for Unfiled.</p>{folderError && <p className="inline-error" role="alert">{folderError}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={closeModal} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}Move</button></div></form></Modal>}
    {modal === 'folder' && <Modal title={folderEditor.kind === 'create' ? 'New folder' : folderEditor.kind === 'rename' ? 'Rename folder' : 'Remove empty folder'} close={closeModal}><form onSubmit={event => { event.preventDefault(); void changeFolder() }}>{folderEditor.kind === 'remove' ? <p className="folder-context">Remove “{folderEditor.path}” and its empty subfolders?</p> : <>{folderEditor.kind === 'create' ? <><label className="field-label" htmlFor="folder-parent">Parent folder</label><select id="folder-parent" value={folderEditor.path} disabled={busy} onChange={event => setFolderEditor(current => ({ ...current, path: event.target.value }))}><option value="">No parent</option>{paths.map(path => <option key={path} value={path}>{path}</option>)}</select></> : <p className="folder-context">{folderEditor.path}</p>}<label className="field-label" htmlFor="folder-name">Folder name</label><input id="folder-name" value={folderInput} onChange={event => { setFolderInput(event.target.value); setFolderError('') }} maxLength={80} disabled={busy} autoFocus /></>}{folderError && <p className="inline-error" role="alert">{folderError}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={closeModal} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}{folderEditor.kind === 'create' ? 'Create folder' : folderEditor.kind === 'rename' ? 'Rename folder' : 'Remove folder'}</button></div></form></Modal>}
    {modal === 'delete' && note && <Modal title="Move note to Trash?" close={closeModal}><p>“{note.title || 'Untitled note'}” will move to Trash. Its private text and editing history remain recoverable{active.published ? '; the public copy is removed after synchronization' : ''}.</p><div className="modal-actions"><button className="button secondary" onClick={closeModal}>Keep note</button><button className="button danger" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />Move to Trash</button></div></Modal>}
    {modal === 'help' && <Modal title="Help" close={closeModal}><div className="help-item"><LockKeyhole size={20} /><div><h3>Privacy</h3><p>Notes autosave to your Pubky homeserver under <code>/priv/notes/</code>. This restricts access, but is not end-to-end encryption: your homeserver operator can read the data.</p></div></div><div className="help-item"><Globe2 size={20} /><div><h3>Sharing</h3><p>Publish a public snapshot using Share. Later edits stay private until you choose Update public copy.</p></div></div><div className="help-item"><Code2 size={20} /><div><h3>Editing</h3><p>Write Markdown, preview as you go, and import or export <code>.md</code> files. Press Ctrl/⌘ + S to save immediately. Remote images are shown as text to protect reader privacy.</p></div></div><p className="hint">Drafts save on this device, then merge with your homeserver when connected. Local drafts upload privately after login. Trash retains private text and editing history. Clear browser data only after your notes have synced; overlapping edits may need cleanup.</p><a href="https://pubky.org/developer-guide.md" target="_blank" rel="noreferrer" className="button secondary small">Pubky documentation <ExternalLink size={14} /></a></Modal>}
  </div>
}
