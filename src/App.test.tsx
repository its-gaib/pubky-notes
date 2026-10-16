// @vitest-environment jsdom

import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@synonymdev/pubky'
import type { Note, NoteRecord } from './lib/notes'
import App from './App'
import { IDBFactory } from 'fake-indexeddb'
import { closeLocalNotebook } from './lib/local-notebook'
import { initializeNote } from './lib/crdt'

configure({ asyncUtilTimeout: 3000 })

const mocks = vi.hoisted(() => ({
  restoreSession: vi.fn(),
  startSignIn: vi.fn(),
  persistSession: vi.fn(),
  discardSession: vi.fn(),
  signOut: vi.fn(),
  createNote: vi.fn(),
  listNotes: vi.fn(),
  saveNote: vi.fn(),
  publishNote: vi.fn(),
  unpublishNote: vi.fn(),
  deleteNote: vi.fn(),
  loadPublicNote: vi.fn(),
  qrCode: vi.fn(),
  loadFolders: vi.fn(),
  saveFolders: vi.fn(),
}))

vi.mock('./lib/pubky', () => ({
  restoreSession: mocks.restoreSession,
  startSignIn: mocks.startSignIn,
  persistSession: mocks.persistSession,
  discardSession: mocks.discardSession,
  signOut: mocks.signOut,
}))

vi.mock('./lib/notes', () => ({
  createNote: mocks.createNote,
  listNotes: mocks.listNotes,
  saveNote: mocks.saveNote,
  publishNote: mocks.publishNote,
  unpublishNote: mocks.unpublishNote,
  deleteNote: mocks.deleteNote,
  loadPublicNote: mocks.loadPublicNote,
}))

vi.mock('./lib/folder-store', async importOriginal => ({
  ...await importOriginal<typeof import('./lib/folder-store')>(),
  loadFolders: mocks.loadFolders, saveFolders: mocks.saveFolders,
}))

vi.mock('qrcode', () => ({
  default: { toDataURL: mocks.qrCode },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const savedNote: Note = {
  id: '8fcce6b4-2854-4b34-8aa5-9018e53b6132',
  title: 'My private note',
  content: 'Private words before editing.',
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
}

function savedNotebook(): NoteRecord[] {
  return [{ note: { ...savedNote }, published: null }]
}

function candidateSession(): Session {
  return {
    info: { publicKey: { z32: () => 'y'.repeat(52) } },
    signout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session
}

async function startConnection() {
  const approval = deferred<Session>()
  const cancel = vi.fn()
  mocks.startSignIn.mockResolvedValue({
    authorizationUrl: 'pubkyring://authorize?request=notes-test',
    awaitApproval: approval.promise,
    cancel,
  })
  render(<App />)
  const connect = screen.getByRole('button', { name: 'Connect Pubky' })
  await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(connect)
  await screen.findByRole('link', { name: 'Open Pubky Ring' })
  return { approval, cancel }
}

async function approve(approval: ReturnType<typeof deferred<Session>>, session: Session) {
  await act(async () => { approval.resolve(session) })
}

beforeEach(async () => {
  await closeLocalNotebook()
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  vi.resetAllMocks()
  window.history.replaceState(null, '', '/')
  mocks.restoreSession.mockResolvedValue(null)
  mocks.loadFolders.mockResolvedValue([])
  mocks.saveFolders.mockImplementation(async (_session, paths) => { mocks.loadFolders.mockResolvedValue(paths); return paths })
  mocks.qrCode.mockResolvedValue('data:image/png;base64,cXI=')
  mocks.persistSession.mockResolvedValue('stored-candidate-id')
  mocks.discardSession.mockResolvedValue(undefined)
  mocks.signOut.mockResolvedValue(undefined)
  mocks.listNotes.mockResolvedValue(savedNotebook())
  mocks.createNote.mockImplementation((text: Partial<Pick<Note, 'title' | 'content' | 'folder'>> = {}) => initializeNote({
    id: 'de0671c0-3626-483a-a482-817e8fae2bc8',
    title: 'Untitled note',
    content: '',
    ...text,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  }))
  mocks.saveNote.mockImplementation(async (_session: Session, note: Note) => note)
  mocks.publishNote.mockImplementation(async (_session: Session, note: Note) => note)
})

afterEach(async () => {
  cleanup()
  await closeLocalNotebook()
  vi.useRealTimers()
})

describe('sign-in candidate lifecycle', () => {
  it('loads the notebook successfully before persisting or displaying the approved identity', async () => {
    const session = candidateSession()
    const listing = deferred<NoteRecord[]>()
    mocks.listNotes.mockReturnValue(listing.promise)
    const { approval } = await startConnection()

    await approve(approval, session)

    expect(mocks.listNotes).toHaveBeenCalledWith(session)
    expect(mocks.persistSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Disconnect from Pubky' })).toBeNull()

    await act(async () => { listing.resolve(savedNotebook()) })

    await screen.findByRole('button', { name: 'Disconnect from Pubky' })
    expect(mocks.persistSession).toHaveBeenCalledExactlyOnceWith(session)
    expect(mocks.listNotes.mock.invocationCallOrder[0]).toBeLessThan(mocks.persistSession.mock.invocationCallOrder[0])
    expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe(savedNote.title)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.discardSession).not.toHaveBeenCalled()
  })

  it('discards an approved candidate when canceled while its notebook is loading', async () => {
    const session = candidateSession()
    const listing = deferred<NoteRecord[]>()
    mocks.listNotes.mockReturnValue(listing.promise)
    const { approval, cancel } = await startConnection()

    await approve(approval, session)
    expect(mocks.listNotes).toHaveBeenCalledWith(session)
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    await act(async () => { listing.resolve(savedNotebook()) })

    await waitFor(() => expect(mocks.discardSession).toHaveBeenCalledExactlyOnceWith(session))
    expect(cancel).toHaveBeenCalledOnce()
    expect(mocks.persistSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Disconnect from Pubky' })).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe('Markdown basics')
  })

  it('discards the candidate and preserves the scratchpad if listing its notes fails', async () => {
    const session = candidateSession()
    mocks.listNotes.mockRejectedValue(new Error('Homeserver unavailable'))
    const { approval } = await startConnection()

    await approve(approval, session)

    expect((await screen.findByRole('alert')).textContent).toContain('Homeserver unavailable')
    expect(mocks.discardSession).toHaveBeenCalledExactlyOnceWith(session, undefined)
    expect(mocks.persistSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Disconnect from Pubky' })).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe('Markdown basics')
  })

  it('cleans up the specific stored record if canceled while persistence is pending', async () => {
    const session = candidateSession()
    const persistence = deferred<string>()
    mocks.persistSession.mockReturnValue(persistence.promise)
    const { approval } = await startConnection()

    await approve(approval, session)
    await waitFor(() => expect(mocks.persistSession).toHaveBeenCalledWith(session))
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    await act(async () => { persistence.resolve('canceled-flow-record') })

    await waitFor(() => expect(mocks.discardSession).toHaveBeenCalledExactlyOnceWith(session, 'canceled-flow-record'))
    expect(mocks.signOut).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Disconnect from Pubky' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('private saving and explicit publication', () => {
  it('inserts a chosen table at the saved selection, preserves surrounding text, and renders its dimensions', async () => {
    mocks.restoreSession.mockResolvedValue(candidateSession())
    render(<App />)
    await screen.findByRole('button', { name: 'Disconnect from Pubky' })
    const content = await screen.findByRole('textbox', { name: 'Markdown content' }) as HTMLTextAreaElement
    await waitFor(() => expect(content.value).toBe(savedNote.content))
    fireEvent.change(content, { target: { value: 'Before chosen After' } })
    content.focus(); content.setSelectionRange(7, 13)
    fireEvent.click(screen.getByRole('button', { name: 'Insert table' }))
    fireEvent.click(screen.getByRole('gridcell', { name: '4 columns, 3 rows' }))
    expect(content.value).toMatch(/^Before \n\n\| Header 1 \| Header 2 \| Header 3 \| Header 4 \|/)
    expect(content.value).toMatch(/\n\n After$/)
    expect(content.value).not.toContain('chosen')
    await waitFor(() => expect(content.value.slice(content.selectionStart, content.selectionEnd)).toBe('Header 1'))
    expect(document.activeElement).toBe(content)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4)
    expect(within(table).getAllByRole('cell')).toHaveLength(8)
  })

  it('keeps the empty-notebook sample unsaved and uses it as the template for new notes', async () => {
    const session = candidateSession()
    mocks.restoreSession.mockResolvedValue(session)
    mocks.listNotes.mockResolvedValue([])
    render(<App />)

    const sample = await screen.findByRole('textbox', { name: 'Sample Markdown' }) as HTMLTextAreaElement
    expect(sample.readOnly).toBe(true)
    expect(sample.value).toContain('**Bold**')
    expect(screen.getByRole('button', { name: 'Copy Markdown' })).toBeTruthy()


    await act(async () => { await new Promise(resolve => setTimeout(resolve, 950)) })
    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })
    expect(mocks.saveNote).not.toHaveBeenCalled()
    expect(mocks.publishNote).not.toHaveBeenCalled()

    await act(async () => { fireEvent.click(within(screen.getByRole('complementary', { name: 'Notebook' })).getByRole('button', { name: 'New note' })) })
    expect(screen.queryByRole('textbox', { name: 'Sample Markdown' })).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Markdown content' }) as HTMLTextAreaElement).value).toBe(sample.value)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 950)) })
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledExactlyOnceWith(session, expect.objectContaining({
      title: 'Untitled note',
      content: sample.value,
    })))
    expect(mocks.publishNote).not.toHaveBeenCalled()
  })

  it('autosaves edits privately and publishes only after confirmation in Share', async () => {
    const session = candidateSession()
    mocks.restoreSession.mockResolvedValue(session)
    render(<App />)
    await screen.findByRole('button', { name: 'Disconnect from Pubky' })
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe(savedNote.title))
    expect(screen.queryByRole('textbox', { name: 'Sample Markdown' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Write' }))

    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown content' }), {
      target: { value: 'A private edit that is not ready for publication.' },
    })
    expect(mocks.saveNote).not.toHaveBeenCalled()
    expect(mocks.publishNote).not.toHaveBeenCalled()

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 950)) })

    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledExactlyOnceWith(session, expect.objectContaining({
      id: savedNote.id,
      content: 'A private edit that is not ready for publication.',
    })))
    expect(mocks.publishNote).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(screen.getByRole('dialog', { name: 'Share note' })).toBeTruthy()
    expect(mocks.publishNote).not.toHaveBeenCalled()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish public copy' })) })

    await waitFor(() => expect(mocks.publishNote).toHaveBeenCalledExactlyOnceWith(session, expect.objectContaining({
      id: savedNote.id,
      content: 'A private edit that is not ready for publication.',
    })))
    await waitFor(() => expect(screen.getByText('Saved to Pubky')).toBeTruthy())
    expect(screen.getByText('Public copy published.')).toBeTruthy()
  })
})

describe('folders and notebook-wide search', () => {
  function organizedNotebook(): NoteRecord[] {
    const privateGarden = { ...savedNote, title: 'Private garden', content: 'Tomatoes and herbs.', folder: 'Personal/Garden' }
    const publicGarden = { ...savedNote, id: 'public-garden', title: 'Public garden', content: 'Tomatoes in the community garden.', folder: 'Work' }
    const otherPrivate = { ...savedNote, id: 'unfiled-garden', title: 'Unfiled garden', content: 'Tomatoes to grow.' }
    return [
      { note: privateGarden, published: null },
      { note: publicGarden, published: { ...publicGarden } },
      { note: otherPrivate, published: null },
    ]
  }

  async function openNotebook(records: NoteRecord[]) {
    const session = candidateSession()
    mocks.restoreSession.mockResolvedValue(session)
    mocks.listNotes.mockResolvedValue(records)
    render(<App />)
    await screen.findByRole('button', { name: 'Disconnect from Pubky' })
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe(records[0].note.title))
    await waitFor(() => expect(screen.getByText('Saved to Pubky')).toBeTruthy())
    return session
  }

  it('searches title and content across collapsed folders and visibility, then restores the collapsed tree', async () => {
    await openNotebook(organizedNotebook())
    const notes = within(screen.getByRole('navigation', { name: 'Folders and notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open folder Personal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse folder Personal' }))
    expect(notes.queryByRole('button', { name: 'Open note Private garden' })).toBeNull()
    expect(notes.getByRole('button', { name: 'Open note Public garden' })).toBeTruthy()
    expect(notes.getByRole('button', { name: 'Open note Unfiled garden' })).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search all notes' }), {
      target: { value: ' GARDEN tomatoes ' },
    })
    expect(notes.getByRole('button', { name: 'Open note Private garden' })).toBeTruthy()
    expect(notes.getByRole('button', { name: 'Open note Public garden' })).toBeTruthy()
    expect(notes.getByRole('button', { name: 'Open note Unfiled garden' })).toBeTruthy()
    expect(notes.getByRole('button', { name: 'Open folder Personal/Garden' })).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search all notes' }), { target: { value: 'herbs' } })
    expect(notes.getByRole('button', { name: 'Open note Private garden' })).toBeTruthy()
    expect(notes.queryByRole('button', { name: 'Open note Public garden' })).toBeNull()
    expect(notes.queryByRole('button', { name: 'Open note Unfiled garden' })).toBeNull()
    expect(notes.queryByRole('button', { name: 'Open folder Work' })).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe('Private garden')

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(notes.getByRole('button', { name: 'Expand folder Personal' })).toBeTruthy()
    expect(notes.queryByRole('button', { name: 'Open note Private garden' })).toBeNull()
    expect(notes.getByRole('button', { name: 'Open note Public garden' })).toBeTruthy()
    expect(notes.getByRole('button', { name: 'Open note Unfiled garden' })).toBeTruthy()
    expect(mocks.saveNote).not.toHaveBeenCalled()
    expect(mocks.publishNote).not.toHaveBeenCalled()
  })

  it('creates a nested folder and moves a note entirely within the sidebar, saving organization privately', async () => {
    const original = { ...savedNote }
    const session = await openNotebook([{ note: original, published: { ...original } }])
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Work' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create folder' })) })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull())
    await screen.findByRole('button', { name: 'Open folder Work' })
    fireEvent.click(screen.getByRole('button', { name: 'New subfolder in Work' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Project' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create folder' })) })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull())
    await screen.findByRole('button', { name: 'Open folder Work/Project' })
    fireEvent.click(screen.getByRole('button', { name: /^Notes$/ }))
    const source = screen.getByRole('button', { name: `Open note ${original.title}` })
    const destination = screen.getByRole('button', { name: 'Open folder Work/Project' })
    expect(destination.closest('#notebook-navigation')).not.toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    const dataTransfer = { effectAllowed: 'uninitialized', dropEffect: 'none', setData: vi.fn() }
    await act(async () => {
      fireEvent.dragStart(source, { dataTransfer })
      fireEvent.dragOver(destination, { dataTransfer })
      fireEvent.drop(destination, { dataTransfer })
      fireEvent.dragEnd(source, { dataTransfer })
    })
    await waitFor(() => expect(screen.getByRole('button', { name: `Open note ${original.title}` }).closest('[data-folder-path]')?.getAttribute('data-folder-path')).toBe('Work/Project'))
    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })

    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledWith(session, expect.objectContaining({
      id: original.id, title: original.title, content: original.content, folder: 'Work/Project',
    })))
    expect(screen.getByRole('button', { name: 'Open folder Work' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open folder Work/Project' })).toBeTruthy()
    expect(mocks.publishNote).not.toHaveBeenCalled()
    expect(mocks.unpublishNote).not.toHaveBeenCalled()
  }, 15_000) // Includes three persisted sidebar operations alongside the parallel app suites.

  it('starts a new note in the selected nested folder with the Markdown template', async () => {
    const session = await openNotebook(organizedNotebook())
    fireEvent.click(screen.getByRole('button', { name: 'Open folder Personal/Garden' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('complementary', { name: 'Notebook' })).getByRole('button', { name: 'New note' })) })
    const content = (screen.getByRole('textbox', { name: 'Markdown content' }) as HTMLTextAreaElement).value
    expect(content).toContain('## Heading')
    expect(content).toContain('**Bold**')
    expect(content).toContain('- [ ] Task')
    expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe('Untitled note')
    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) })

    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledExactlyOnceWith(session, expect.objectContaining({
      title: 'Untitled note', content, folder: 'Personal/Garden',
    })))
    expect(mocks.publishNote).not.toHaveBeenCalled()
  })
})
