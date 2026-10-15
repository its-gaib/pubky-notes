// @vitest-environment jsdom
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  await waitFor(() => expect((screen.getByRole('button', { name: 'New note' }) as HTMLButtonElement).disabled).toBe(false))
  await waitFor(() => expect(screen.getByText('Saved to Pubky')).toBeTruthy())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Open note ${records[0].note.title}` })) })
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe(records[0].note.title))
}
function folderMenu(path: string, action: string) {
  fireEvent.click(screen.getByRole('button', { name: `Folder actions for ${path}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: action }))
}
function noteMenu(title: string) {
  fireEvent.click(screen.getByRole('button', { name: `Note actions for ${title}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }))
}
function folder(path: string) { return screen.getByRole('button', { name: `Open folder ${path}` }) }
function folderName() { return screen.getByRole('textbox', { name: 'Folder name' }) as HTMLInputElement }
function expectInline(control: HTMLElement) {
  expect(control.closest('#notebook-navigation, #notebook-notes')).not.toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
}
async function flush() {
  await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })
  await waitFor(() => expect(screen.getByText('Saved to Pubky')).toBeTruthy())
}
async function submit(button: string) {
  const control = screen.getByRole('button', { name: button })
  expectInline(control)
  await act(async () => { fireEvent.click(control) })
  await waitFor(() => expect(screen.queryByRole('button', { name: button })).toBeNull())
  await flush()
}
function dataTransfer() {
  const values = new Map<string, string>()
  return {
    effectAllowed: 'uninitialized', dropEffect: 'none', files: [], types: [] as string[],
    setData(type: string, value: string) { values.set(type, value); this.types.push(type) },
    getData: vi.fn((type: string) => values.get(type) ?? ''), clearData() { values.clear() }, setDragImage: vi.fn(),
  }
}
async function drag(source: HTMLElement, target: HTMLElement) {
  const transfer = dataTransfer()
  expect(source.draggable).toBe(true)
  await act(async () => {
    fireEvent.dragStart(source, { dataTransfer: transfer })
    fireEvent.dragOver(target, { dataTransfer: transfer })
    fireEvent.drop(target, { dataTransfer: transfer })
    fireEvent.dragEnd(source, { dataTransfer: transfer })
  })
  await waitFor(() => expect((screen.getByRole('button', { name: 'New note' }) as HTMLButtonElement).disabled).toBe(false))
}
beforeEach(async () => {
  await closeLocalNotebook()
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  vi.resetAllMocks(); window.history.replaceState(null, '', '/')
  mocks.restore.mockResolvedValue(session)
  mocks.save.mockImplementation(async (_session: Session, note: Note) => note)
  mocks.saveFolders.mockImplementation(async (_session: Session, paths: string[]) => { mocks.loadFolders.mockResolvedValue(paths); return paths })
})
afterEach(async () => { cleanup(); await closeLocalNotebook(); vi.useRealTimers() })

// These workflows render the full app and persist multiple IndexedDB transactions.
// Keep each condition's 3s deadline, while allowing the complete workflow time under parallel load.
describe('sidebar folder management', { timeout: 15_000 }, () => {
  it('shows notes in their folder tree independently of filters and collapses folders containing only notes', async () => {
    const deleted = row('Deleted', 'Work')
    deleted.note.deleted = true
    await open([row('First'), row('Second', 'Work'), deleted])
    const tree = within(screen.getByRole('navigation', { name: 'Folders and notes' }))
    const rootNote = tree.getByRole('button', { name: 'Open note First in folder tree' })
    const nestedNote = tree.getByRole('button', { name: 'Open note Second in folder tree' })
    expect(rootNote.closest('[data-folder-path]')).toBeNull()
    expect(nestedNote.closest('[data-folder-path]')?.getAttribute('data-folder-path')).toBe('Work')
    expect(tree.queryByRole('button', { name: 'Open note Deleted in folder tree' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Unfiled' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Public' }))
    expect(tree.getByRole('button', { name: 'Open note Second in folder tree' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse folder Work' }))
    expect(tree.queryByRole('button', { name: 'Open note Second in folder tree' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand folder Work' }))
    await act(async () => { fireEvent.click(tree.getByRole('button', { name: 'Open note Second in folder tree' })) })
    expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe('Second')
    expect(window.location.pathname.endsWith('/priv/notes/Second.json')).toBe(true)
  })

  it('moves a non-active note from the sidebar without changing the editor or publishing', async () => {
    await open([row('First'), row('Second', undefined, true)], ['Work'])
    const noteUrl = window.location.pathname
    expect(document.querySelector('.editor-bottom button.folder-location')).toBeNull()
    noteMenu('Second')
    const destination = screen.getByRole('combobox', { name: 'Move note to' })
    expectInline(destination)
    fireEvent.change(destination, { target: { value: 'Work' } })
    await submit('Move')
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(session, expect.objectContaining({ id: 'Second', folder: 'Work', content: 'Content of Second' }))
    expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe('First')
    expect((screen.getByRole('textbox', { name: 'Markdown content' }) as HTMLTextAreaElement).value).toBe('Content of First')
    expect(window.location.pathname).toBe(noteUrl)
    expect(mocks.publish).not.toHaveBeenCalled()
    expect((await readLocalNotebook(scopeForSession(session))).records.find(record => record.note.id === 'Second')?.published).toEqual(row('Second', undefined, true).published)
  })

  it('creates and restores empty folders, with nested creation entirely in the sidebar', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    expectInline(folderName())
    fireEvent.change(folderName(), { target: { value: 'Work' } })
    await submit('Create folder')
    expect(mocks.saveFolders).toHaveBeenCalledWith(session, ['Work'])
    expect(mocks.save).not.toHaveBeenCalled()
    expect(folder('Work')).toBeTruthy()
    cleanup()
    await open(undefined, ['Work'])
    folderMenu('Work', 'New subfolder')
    expectInline(folderName())
    fireEvent.change(folderName(), { target: { value: 'Ideas' } })
    await submit('Create folder')
    expect(mocks.saveFolders).toHaveBeenLastCalledWith(session, ['Work', 'Work/Ideas'])
    expect(folder('Work/Ideas')).toBeTruthy()
  })

  it('edits the selected folder leaf name on a second click, cancels with Escape, and commits with Enter', async () => {
    const user = userEvent.setup()
    await open([row('First', 'Work/Ideas')])
    fireEvent.click(folder('Work/Ideas'))
    expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull()
    fireEvent.click(folder('Work/Ideas'))
    expectInline(folderName())
    expect(document.activeElement).toBe(folderName())
    expect(folderName().value).toBe('Ideas')
    fireEvent.change(folderName(), { target: { value: 'Canceled' } })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull()
    expect(folder('Work/Ideas')).toBeTruthy()
    expect(mocks.saveFolders).not.toHaveBeenCalled()
    fireEvent.click(folder('Work/Ideas'))
    fireEvent.change(folderName(), { target: { value: 'Research' } })
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull())
    await flush()
    expect(folder('Work/Research')).toBeTruthy()
    expect(mocks.save).toHaveBeenCalledWith(session, expect.objectContaining({ id: 'First', folder: 'Work/Research' }))
  })

  it('renames a subtree while preserving other folders, note URLs, contents, and public snapshots', async () => {
    const original = row('First', 'Work', true)
    await open([original, row('Second', 'Work/Ideas'), row('Third', 'Workshop')], ['Work/Empty'])
    const noteUrl = window.location.pathname
    folderMenu('Work', 'Rename')
    fireEvent.change(folderName(), { target: { value: 'Projects' } })
    await submit('Rename folder')
    expect(mocks.save.mock.calls.map(([, note]) => [note.id, note.folder, note.content]).sort()).toEqual([['First', 'Projects', 'Content of First'], ['Second', 'Projects/Ideas', 'Content of Second']])
    expect(mocks.saveFolders).toHaveBeenLastCalledWith(session, ['Projects', 'Projects/Empty', 'Projects/Ideas', 'Workshop'])
    expect(mocks.saveFolders.mock.invocationCallOrder[0]).toBeLessThan(mocks.save.mock.invocationCallOrder[0])
    expect(screen.queryByRole('button', { name: 'Open folder Work' })).toBeNull()
    expect(folder('Workshop')).toBeTruthy()
    expect(screen.getByText('Public copy')).toBeTruthy()
    expect(window.location.pathname).toBe(noteUrl)
    expect((await readLocalNotebook(scopeForSession(session))).records.find(record => record.note.id === 'First')?.published).toEqual(original.published)
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('keeps edits made while a folder rename is open', async () => {
    await open([row('First', 'Work')])
    folderMenu('Work', 'Rename')
    fireEvent.change(folderName(), { target: { value: 'Projects' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown content' }), { target: { value: 'Latest unsaved text.' } })
    await submit('Rename folder')
    const saved = (await readLocalNotebook(scopeForSession(session))).records.find(record => record.note.id === 'First')?.note
    expect(saved).toMatchObject({ id: 'First', content: 'Latest unsaved text.', folder: 'Projects' })
    expect(mocks.save).toHaveBeenLastCalledWith(session, expect.objectContaining({ content: 'Latest unsaved text.', folder: 'Projects' }))
  })

  it('keeps a renamed subtree locally when the homeserver fails and retries its pending notes', async () => {
    await open([row('First', 'Work'), row('Second', 'Work/Ideas')])
    mocks.save.mockRejectedValue(new Error('Homeserver offline'))
    folderMenu('Work', 'Rename')
    fireEvent.change(folderName(), { target: { value: 'Projects' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Rename folder' })) })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull())
    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })
    await waitFor(() => expect(mocks.save).toHaveBeenCalled())
    const cached = await readLocalNotebook(scopeForSession(session))
    expect(cached.records.map(record => record.note.folder).sort()).toEqual(['Projects', 'Projects/Ideas'])
    expect(cached.pending).toHaveLength(2)
    expect(folder('Projects')).toBeTruthy()
    mocks.save.mockImplementation(async (_session, note) => note)
    await flush()
    expect((await readLocalNotebook(scopeForSession(session))).pending).toEqual([])
  })

  it('deletes only empty leaf folders through adjacent controls and preserves their parents', async () => {
    await open([row('First', 'Work/Ideas')], ['Personal/Empty'])
    const deleteWork = screen.getByRole('button', { name: 'Delete folder Work' }) as HTMLButtonElement
    const deletePersonal = screen.getByRole('button', { name: 'Delete folder Personal' }) as HTMLButtonElement
    const deleteEmpty = screen.getByRole('button', { name: 'Delete folder Personal/Empty' }) as HTMLButtonElement
    expect(deleteWork.disabled).toBe(true)
    expect(deletePersonal.disabled).toBe(true)
    expect(deleteEmpty.disabled).toBe(false)
    expectInline(deleteEmpty)
    expect(deleteEmpty.closest('.folder-entry')?.contains(folder('Personal/Empty'))).toBe(true)
    fireEvent.click(deleteWork)
    fireEvent.click(deletePersonal)
    expect(mocks.saveFolders).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(deleteEmpty) })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open folder Personal/Empty' })).toBeNull())
    expect(folder('Personal')).toBeTruthy()
    await flush()
    expect(mocks.saveFolders).toHaveBeenLastCalledWith(session, ['Personal', 'Work', 'Work/Ideas'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete folder Personal' })) })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open folder Personal' })).toBeNull())
    await flush()
    expect(mocks.saveFolders).toHaveBeenLastCalledWith(session, ['Work', 'Work/Ideas'])
    expect(mocks.save).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('drags a note into a folder and back to the top level using All notes without publishing or changing its identity', async () => {
    const original = row('Second', undefined, true)
    await open([row('First'), original], ['Work'])
    const noteUrl = window.location.pathname
    await drag(screen.getByRole('button', { name: 'Open note Second in folder tree' }), folder('Work'))
    await flush()
    expect(mocks.save).toHaveBeenLastCalledWith(session, expect.objectContaining({ id: 'Second', folder: 'Work', content: original.note.content }))
    fireEvent.click(folder('Work'))
    await drag(screen.getByRole('button', { name: 'Open note Second in folder tree' }), screen.getByRole('button', { name: 'All notes' }))
    await flush()
    const moved = (await readLocalNotebook(scopeForSession(session))).records.find(record => record.note.id === 'Second')
    expect(moved?.note.folder || '').toBe('')
    expect(moved?.note).toMatchObject({ id: original.note.id, content: original.note.content, createdAt: original.note.createdAt })
    expect(moved?.published).toEqual(original.published)
    expect(folder('Work')).toBeTruthy()
    expect(window.location.pathname).toBe(noteUrl)
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('drags a nested folder and its descendants into another folder and back to the root', async () => {
    const original = row('First', 'Work/Ideas', true)
    await open([original, row('Second', 'Work/Ideas/Deep'), row('Third', 'Personal')], ['Work/Ideas/Empty', 'Archive'])
    const noteUrl = window.location.pathname
    fireEvent.click(folder('Work/Ideas'))
    await drag(folder('Work/Ideas'), folder('Archive'))
    await flush()
    expect(folder('Archive/Ideas')).toBeTruthy()
    expect(folder('Archive/Ideas/Deep')).toBeTruthy()
    expect(folder('Archive/Ideas/Empty')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open folder Work/Ideas' })).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Notes' })).getByRole('button', { name: 'Open note First' })).toBeTruthy()
    await drag(folder('Archive/Ideas'), screen.getByRole('button', { name: 'All notes' }))
    await flush()
    expect(folder('Ideas/Deep')).toBeTruthy()
    expect(folder('Ideas/Empty')).toBeTruthy()
    const records = (await readLocalNotebook(scopeForSession(session))).records
    expect(records.map(record => [record.note.id, record.note.folder, record.note.content]).sort()).toEqual([
      ['First', 'Ideas', 'Content of First'], ['Second', 'Ideas/Deep', 'Content of Second'], ['Third', 'Personal', 'Content of Third'],
    ])
    expect(records.find(record => record.note.id === 'First')?.published).toEqual(original.published)
    expect(window.location.pathname).toBe(noteUrl)
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ignores external drag payloads and rejects folder cycles and destination collisions before writes', async () => {
    await open([row('First', 'Work/Ideas')], ['Archive/Work'])
    const external = dataTransfer()
    external.setData('application/x-pubky-notes', JSON.stringify({ kind: 'folder', path: 'Work' }))
    external.setData('text/plain', 'Work')
    await act(async () => {
      fireEvent.dragOver(folder('Archive'), { dataTransfer: external })
      fireEvent.drop(folder('Archive'), { dataTransfer: external })
    })
    expect(mocks.saveFolders).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    await drag(folder('Work'), folder('Work/Ideas'))
    expect(mocks.saveFolders).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    await drag(folder('Work'), folder('Archive'))
    expect(mocks.saveFolders).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(folder('Work/Ideas')).toBeTruthy()
    expect(folder('Archive/Work')).toBeTruthy()
    folderMenu('Work', 'Rename')
    fireEvent.change(folderName(), { target: { value: 'Archive' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename folder' }))
    expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('already exists'))).toBe(true)
    expect(mocks.saveFolders).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('supports keyboard folder moves and dismisses sidebar menus on Escape and outside clicks', async () => {
    const user = userEvent.setup()
    await open([row('First', 'Work/Ideas')], ['Archive'])
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
    folderMenu('Work', 'Move to…')
    const destination = screen.getByRole('combobox', { name: 'Move folder to' })
    expectInline(destination)
    expect(within(destination).queryByRole('option', { name: 'Work/Ideas' })).toBeNull()
    await user.selectOptions(destination, 'Archive')
    screen.getByRole('button', { name: 'Move' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Move folder to' })).toBeNull())
    await flush()
    expect(folder('Archive/Work/Ideas')).toBeTruthy()
    expect(mocks.save).toHaveBeenCalledWith(session, expect.objectContaining({ id: 'First', folder: 'Archive/Work/Ideas' }))
  })
})
