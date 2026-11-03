// @vitest-environment jsdom
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@synonymdev/pubky'
import App from './App'
import { checkpointNote, editNote, initializeNote, listNoteVersions, readNoteVersion } from './lib/crdt'
import type { Note, NoteRecord } from './lib/notes'
import { closeLocalNotebook, readLocalNotebook } from './lib/local-notebook'
import { GUEST_SCOPE, scopeForSession } from './lib/notebook-sync'
import { createNotebookBackup } from './lib/notebook-backup'

configure({ asyncUtilTimeout: 4_000 })
const mocks = vi.hoisted(() => ({
  restore: vi.fn(), signOut: vi.fn(), list: vi.fn(), save: vi.fn(), publish: vi.fn(),
  loadFolders: vi.fn(), saveFolders: vi.fn(), localWriteStarted: vi.fn(),
  remote: [] as NoteRecord[], folders: [] as string[], failedTitle: null as string | null,
  archiveGate: null as Promise<void> | null, archiveStarted: vi.fn(),
}))
vi.mock('./lib/pubky', () => ({ restoreSession: mocks.restore, startSignIn: vi.fn(), persistSession: vi.fn(), discardSession: vi.fn(), signOut: mocks.signOut }))
vi.mock('./lib/notes', async original => ({ ...await original<typeof import('./lib/notes')>(), listNotes: mocks.list, saveNote: mocks.save, publishNote: mocks.publish }))
vi.mock('./lib/folder-store', async original => ({ ...await original<typeof import('./lib/folder-store')>(), loadFolders: mocks.loadFolders, saveFolders: mocks.saveFolders }))
vi.mock('./lib/local-notebook', async original => {
  const actual = await original<typeof import('./lib/local-notebook')>()
  return { ...actual, writeLocalNote: async (...args: Parameters<typeof actual.writeLocalNote>) => {
    mocks.localWriteStarted(...args)
    if (args[1].note.title === mocks.failedTitle) throw new Error('Device storage is temporarily full.')
    return actual.writeLocalNote(...args)
  } }
})
vi.mock('./lib/notebook-backup', async original => {
  const actual = await original<typeof import('./lib/notebook-backup')>()
  return { ...actual, createMarkdownArchive: async (...args: Parameters<typeof actual.createMarkdownArchive>) => {
    const archive = await actual.createMarkdownArchive(...args)
    mocks.archiveStarted()
    if (mocks.archiveGate) await mocks.archiveGate
    return archive
  } }
})
vi.mock('./lib/profile', () => ({ loadProfile: vi.fn(async () => ({ name: 'Test account' })), loadAvatar: vi.fn() }))

const now = '2026-11-03T00:00:00.000Z'
const session = { info: { publicKey: { z32: () => 'y'.repeat(52) } } } as unknown as Session
function row(id: string, title = id, content = `Original ${title}`): NoteRecord {
  return { note: initializeNote({ id, title, content, createdAt: now, updatedAt: now }), published: null }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function open(records: NoteRecord[] = [row('original')], folders: string[] = []) {
  mocks.remote = records; mocks.folders = folders
  render(<App />)
  await screen.findByRole('button', { name: 'Disconnect from Pubky' })
  await screen.findByText('Saved to Pubky')
  await waitFor(() => expect((screen.getByRole('button', { name: 'New note' }) as HTMLButtonElement).disabled).toBe(false))
}
function panel() {
  fireEvent.click(screen.getByRole('button', { name: 'Notebook options' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Backup and import' }))
  return screen.getByRole('dialog', { name: 'Backup and import' })
}
async function choose(files: File[]) {
  fireEvent.change(screen.getByLabelText('Import notebook files'), { target: { files } })
  return screen.findByRole('region', { name: 'Import preview' })
}
function selectImport(preview: HTMLElement) { fireEvent.click(within(preview).getByRole('button', { name: 'Import private copies' })) }
async function cached() { return readLocalNotebook(scopeForSession(session)) }

beforeEach(async () => {
  await closeLocalNotebook(); vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear(); window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
  mocks.failedTitle = null; mocks.archiveGate = null; mocks.remote = []; mocks.folders = []
  mocks.restore.mockResolvedValue(session); mocks.signOut.mockResolvedValue(undefined)
  mocks.list.mockImplementation(async () => mocks.remote)
  mocks.loadFolders.mockImplementation(async () => mocks.folders)
  mocks.saveFolders.mockImplementation(async (_session: Session, folders: string[]) => { mocks.folders = folders; return folders })
  mocks.save.mockImplementation(async (_session: Session, note: Note) => {
    const old = mocks.remote.find(row => row.note.id === note.id)
    mocks.remote = [...mocks.remote.filter(row => row.note.id !== note.id), { note, published: old?.published ?? null }]
    return note
  })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn((_blob: Blob) => 'blob:integration-backup') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(async () => { cleanup(); await closeLocalNotebook(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('notebook backup and bulk import integration', { timeout: 15_000 }, () => {
  it('imports multiple files into a populated notebook without altering originals or public snapshots', async () => {
    const original = row('original', 'Existing public note')
    original.published = { ...original.note, crdt: undefined, content: 'Explicit old public snapshot' }
    await open([original], ['Existing empty folder'])
    panel()
    const one = new File(['# Imported one\n\nBody one.'], 'one.md')
    Object.defineProperty(one, 'webkitRelativePath', { value: 'Imported/Research/one.md' })
    const preview = await choose([one, new File(['Body two.'], 'two.md')])
    expect((await cached()).records).toHaveLength(1)
    selectImport(preview)
    await waitFor(async () => expect((await cached()).records).toHaveLength(3))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Backup and import' })).toBeNull())
    const notebook = await cached()
    expect(notebook.records.find(row => row.note.id === original.note.id)).toEqual(original)
    const imported = notebook.records.filter(row => row.note.id !== original.note.id)
    expect(new Set(imported.map(row => row.note.id)).size).toBe(2)
    expect(imported.every(row => row.published === null)).toBe(true)
    expect(imported.map(row => [row.note.title, row.note.content]).sort()).toEqual([['Imported one', 'Body one.'], ['two', 'Body two.']])
    expect(notebook.folders).toEqual(['Existing empty folder', 'Imported', 'Imported/Research'])
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('restores same-ID backups as independent private copies with dates, folders, and versions preserved', async () => {
    const original = row('same-id', 'Original')
    original.published = { ...original.note, crdt: undefined }
    const backup = row('same-id', 'Restored history', 'Earlier text')
    backup.note = checkpointNote(editNote(backup.note, { content: 'Later text', folder: 'Recovered/Subfolder' }))
    const versions = listNoteVersions(backup.note)
    const json = createNotebookBackup({ records: [backup], folders: ['Recovered/Empty'] })
    await open([original]); panel()
    selectImport(await choose([new File([json], 'whole-notebook.json')]))
    await waitFor(async () => expect((await cached()).records).toHaveLength(2))
    const records = (await cached()).records
    expect(records.find(row => row.note.id === original.note.id)).toEqual(original)
    const restored = records.find(row => row.note.id !== original.note.id)!
    expect(restored.published).toBeNull()
    expect(restored.note).toMatchObject({ title: 'Restored history', content: 'Later text', createdAt: now, folder: 'Recovered/Subfolder' })
    expect(listNoteVersions(restored.note)).toEqual(versions)
    expect(readNoteVersion(restored.note, versions[0].id).content).toBe('Earlier text')
    expect((await cached()).folders).toEqual(['Recovered', 'Recovered/Empty', 'Recovered/Subfolder'])
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('flushes the latest uncheckpointed editor text into a downloaded backup', async () => {
    await open()
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown content' }), { target: { value: 'Latest unsaved editor text.' } })
    panel()
    fireEvent.click(screen.getByRole('button', { name: 'Download notebook backup' }))
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce())
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
    const json = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob) })
    const backup = JSON.parse(json)
    expect(backup.notes).toHaveLength(1)
    expect(backup.notes[0].content).toBe('Latest unsaved editor text.')
    expect(listNoteVersions(backup.notes[0]).length).toBeGreaterThan(1)
    expect((await cached()).records[0].note.content).toBe('Latest unsaved editor text.')
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('keeps the notebook unchanged when an imported backup is invalid', async () => {
    await open()
    const before = await cached(); panel()
    fireEvent.change(screen.getByLabelText('Import notebook files'), { target: { files: [new File(['{"format":"wrong"}'], 'bad.json')] } })
    expect((await screen.findByRole('alert')).textContent).toContain('unsupported')
    expect(screen.queryByRole('region', { name: 'Import preview' })).toBeNull()
    const after = await cached()
    expect(after.records).toEqual(before.records)
    expect(after.folders).toEqual(before.folders)
    expect(after.pending).toEqual(before.pending)
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('retries a partial device-storage failure with the same imported IDs and no duplicate copies', async () => {
    await open(); panel()
    const preview = await choose([new File(['# Import one\n\nOne.'], 'one.md'), new File(['# Import two\n\nTwo.'], 'two.md')])
    mocks.failedTitle = 'Import two'
    selectImport(preview)
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Backup and import' })).getByRole('alert').textContent).toContain('Retry to continue'))
    const partial = await cached()
    expect(partial.records.map(row => row.note.title).sort()).toEqual(['Import one', 'original'])
    const attemptedIds = new Set(mocks.localWriteStarted.mock.calls.map(([, row]) => row.note).filter(note => note.title.startsWith('Import ')).map(note => note.id))
    expect(attemptedIds.size).toBe(2)
    mocks.failedTitle = null
    selectImport(screen.getByRole('region', { name: 'Import preview' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Backup and import' })).toBeNull())
    const restored = await cached()
    expect(restored.records.map(row => row.note.title).sort()).toEqual(['Import one', 'Import two', 'original'])
    expect(new Set(restored.records.filter(row => row.note.title.startsWith('Import ')).map(row => row.note.id))).toEqual(attemptedIds)
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('does not import delayed file parsing into another account or the guest notebook after logout', async () => {
    await open(); const before = await cached(); panel()
    const read = deferred<ArrayBuffer>()
    const file = new File(['# Late import\n\nSensitive text.'], 'late.md')
    Object.defineProperty(file, 'arrayBuffer', { value: () => read.promise })
    fireEvent.change(screen.getByLabelText('Import notebook files'), { target: { files: [file] } })
    await screen.findByText('Preparing notebook…')
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect from Pubky' }))
    await within(screen.getByRole('complementary', { name: 'Notebook' })).findByRole('button', { name: 'Connect Pubky' })
    await act(async () => { read.resolve(new TextEncoder().encode('# Late import\n\nSensitive text.').buffer) })
    expect(screen.queryByRole('dialog', { name: 'Backup and import' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Import preview' })).toBeNull()
    expect((await readLocalNotebook(GUEST_SCOPE)).records).toEqual([])
    expect((await cached()).records).toEqual(before.records)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('cancels a delayed export when its account is disconnected before archive generation finishes', async () => {
    const gate = deferred<void>(); mocks.archiveGate = gate.promise
    await open(); panel()
    fireEvent.click(screen.getByRole('button', { name: 'Export Markdown ZIP' }))
    await waitFor(() => expect(mocks.archiveStarted).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect from Pubky' }))
    await within(screen.getByRole('complementary', { name: 'Notebook' })).findByRole('button', { name: 'Connect Pubky' })
    await act(async () => { gate.resolve() })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Backup and import' })).toBeNull()
    expect((await readLocalNotebook(GUEST_SCOPE)).records).toEqual([])
  })
})
