// @vitest-environment jsdom
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@synonymdev/pubky'
import type { Note, NoteRecord } from './lib/notes'
import App from './App'
import { scopeForSession } from './lib/notebook-sync'
import { IDBFactory } from 'fake-indexeddb'
import { closeLocalNotebook, readLocalNotebook } from './lib/local-notebook'

configure({ asyncUtilTimeout: 3000 })

const mocks = vi.hoisted(() => ({ restore: vi.fn(), list: vi.fn(), save: vi.fn(), loadFolders: vi.fn(), saveFolders: vi.fn(), publish: vi.fn() }))
vi.mock('./lib/pubky', () => ({ restoreSession: mocks.restore, startSignIn: vi.fn(), persistSession: vi.fn(), discardSession: vi.fn(), signOut: vi.fn() }))
vi.mock('./lib/notes', async importOriginal => ({ ...await importOriginal<typeof import('./lib/notes')>(), listNotes: mocks.list, saveNote: mocks.save, publishNote: mocks.publish }))
vi.mock('./lib/folder-store', async importOriginal => ({ ...await importOriginal<typeof import('./lib/folder-store')>(), loadFolders: mocks.loadFolders, saveFolders: mocks.saveFolders }))
vi.mock('./components/AccountProfile', () => ({ default: () => <span>Connected account</span> }))
const session = { info: { publicKey: { z32: () => 'y'.repeat(52) } } } as unknown as Session
function row(id: string, folder?: string, published = false): NoteRecord {
  const note = { id, title: id, content: `Content of ${id}`, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z', ...(folder ? { folder } : {}) }
  return { note, published: published ? { ...note } : null }
}
async function open(records = [row('First'), row('Second')], folders: string[] = []) {
  mocks.list.mockResolvedValue(records)
  mocks.loadFolders.mockResolvedValue(folders)
  render(<App />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'New note' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  await waitFor(() => expect(screen.getByText('Saved to Pubky')).toBeTruthy())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Open note ${records[0].note.title}` })) })
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe(records[0].note.title))
}
function folderMenu(path: string, action: string) {
  fireEvent.click(screen.getByRole('button', { name: `Folder actions for ${path}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: action }))
}
async function submit(button: string) {
  await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: button })) })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })
  await waitFor(() => expect(screen.getByText('Saved to Pubky')).toBeTruthy())
}
beforeEach(async () => {
  await closeLocalNotebook()
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  vi.resetAllMocks(); localStorage.clear(); window.history.replaceState(null, '', '/')
  mocks.restore.mockResolvedValue(session)
  mocks.save.mockImplementation(async (_session: Session, note: Note) => note)
  mocks.saveFolders.mockImplementation(async (_session: Session, paths: string[]) => { mocks.loadFolders.mockResolvedValue(paths); return paths })
})
afterEach(async () => { cleanup(); await closeLocalNotebook(); vi.useRealTimers() })

describe('sidebar folder management', () => {
  it('moves a non-active note to an existing folder without changing the editor or publishing', async () => {
    await open([row('First'), row('Second', undefined, true)], ['Work'])
    expect(document.querySelector('.editor-bottom button.folder-location')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Note actions for Second' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Move to' }), { target: { value: 'Work' } })
    await submit('Move')
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(session, expect.objectContaining({ id: 'Second', folder: 'Work', content: 'Content of Second' }))
    expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe('First')
    expect((screen.getByRole('textbox', { name: 'Markdown content' }) as HTMLTextAreaElement).value).toBe('Content of First')
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('creates empty folders, restores them, and creates nested folders through their sidebar menu', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Work' } })
    await submit('Create folder')
    expect(mocks.saveFolders).toHaveBeenCalledWith(session, ['Work'])
    expect(mocks.save).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Open folder Work' })).toBeTruthy()
    cleanup()
    await open(undefined, ['Work'])
    folderMenu('Work', 'New subfolder')
    expect((screen.getByRole('combobox', { name: 'Parent folder' }) as HTMLSelectElement).value).toBe('Work')
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Ideas' } })
    await submit('Create folder')
    expect(mocks.saveFolders).toHaveBeenLastCalledWith(session, ['Work', 'Work/Ideas'])
    expect(screen.getByRole('button', { name: 'Open folder Work/Ideas' })).toBeTruthy()
  })

  it('renames a whole subtree while preserving other folders, contents, and public snapshots', async () => {
    await open([row('First', 'Work', true), row('Second', 'Work/Ideas'), row('Third', 'Workshop')], ['Work/Empty'])
    folderMenu('Work', 'Rename')
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Projects' } })
    await submit('Rename folder')
    expect(mocks.save.mock.calls.map(([, note]) => [note.id, note.folder, note.content]).sort()).toEqual([['First', 'Projects', 'Content of First'], ['Second', 'Projects/Ideas', 'Content of Second']])
    expect(mocks.saveFolders.mock.calls[0][1]).toEqual(['Projects', 'Projects/Empty', 'Projects/Ideas', 'Workshop'])
    expect(mocks.saveFolders.mock.invocationCallOrder[0]).toBeLessThan(mocks.save.mock.invocationCallOrder[0])
    expect(mocks.saveFolders).toHaveBeenLastCalledWith(session, ['Projects', 'Projects/Empty', 'Projects/Ideas', 'Workshop'])
    expect(screen.queryByRole('button', { name: 'Open folder Work' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open folder Workshop' })).toBeTruthy()
    expect(screen.getByText('Public copy')).toBeTruthy()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('keeps a renamed subtree locally when the homeserver fails and retries its pending notes', async () => {
    await open([row('First', 'Work'), row('Second', 'Work/Ideas')])
    mocks.save.mockRejectedValue(new Error('Homeserver offline'))
    folderMenu('Work', 'Rename')
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Projects' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rename folder' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })
    await waitFor(() => expect(mocks.save).toHaveBeenCalled())
    const cached = await readLocalNotebook(scopeForSession(session))
    expect(cached.records.map(row => row.note.folder).sort()).toEqual(['Projects', 'Projects/Ideas'])
    expect(cached.pending).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Open folder Projects' })).toBeTruthy()
    mocks.save.mockImplementation(async (_session, note) => note)
    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })
    await waitFor(() => expect(screen.getByText('Saved to Pubky')).toBeTruthy())
    expect((await readLocalNotebook(scopeForSession(session))).pending).toEqual([])
  })

  it('rejects collisions before writing and only removes empty subtrees', async () => {
    await open([row('First', 'Work/Ideas')], ['Personal/Empty'])
    folderMenu('Work', 'Rename')
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Personal' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rename folder' }))
    expect(screen.getByRole('alert').textContent).toContain('already exists')
    expect(mocks.saveFolders).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Folder actions for Work' }))
    expect((screen.getByRole('menuitem', { name: 'Remove empty folder' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    folderMenu('Personal', 'Remove empty folder')
    await submit('Remove folder')
    expect(mocks.saveFolders).toHaveBeenLastCalledWith(session, ['Work', 'Work/Ideas'])
    expect(screen.queryByRole('button', { name: 'Open folder Personal' })).toBeNull()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('supports keyboard menu navigation and dismisses actions on Escape and outside clicks', async () => {
    await open([row('First', 'Work')])
    const trigger = screen.getByRole('button', { name: 'Folder actions for Work' })
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'New subfolder' }))
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Note title' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
