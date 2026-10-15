// @vitest-environment jsdom

import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import type { Session } from '@synonymdev/pubky'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { editNote, initializeNote } from './lib/crdt'
import { closeLocalNotebook, readLocalNotebook, setLocalActiveId, writeLocalNote } from './lib/local-notebook'
import { GUEST_SCOPE, scopeForSession } from './lib/notebook-sync'
import type { Note, NoteRecord } from './lib/notes'

configure({ asyncUtilTimeout: 3000 })

const mocks = vi.hoisted(() => ({
  restore: vi.fn(), start: vi.fn(), persist: vi.fn(), discard: vi.fn(), signOut: vi.fn(),
  list: vi.fn(), save: vi.fn(), publish: vi.fn(), unpublish: vi.fn(), remove: vi.fn(),
  publicNote: vi.fn(), loadFolders: vi.fn(), saveFolders: vi.fn(), copy: vi.fn(),
}))

vi.mock('./lib/pubky', () => ({
  restoreSession: mocks.restore, startSignIn: mocks.start, persistSession: mocks.persist,
  discardSession: mocks.discard, signOut: mocks.signOut,
}))
vi.mock('./lib/notes', async importOriginal => ({
  ...await importOriginal<typeof import('./lib/notes')>(),
  listNotes: mocks.list, saveNote: mocks.save, publishNote: mocks.publish,
  unpublishNote: mocks.unpublish, deleteNote: mocks.remove, loadPublicNote: mocks.publicNote,
}))
vi.mock('./lib/folder-store', async importOriginal => ({
  ...await importOriginal<typeof import('./lib/folder-store')>(),
  loadFolders: mocks.loadFolders, saveFolders: mocks.saveFolders,
}))
vi.mock('./lib/profile', () => ({ loadProfile: vi.fn(async () => ({ name: 'Test account' })), loadAvatar: vi.fn() }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,cXI=') } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}
function identity(character: string): Session {
  return { info: { publicKey: { z32: () => character.repeat(52) } } } as unknown as Session
}
const alice = identity('y'), bob = identity('o')
const privatePath = (id: string, session = alice) => `/pubky${session.info.publicKey.z32()}/priv/notes/${id}.json`
const publicPath = (id: string, session = alice) => `/pubky${session.info.publicKey.z32()}/pub/notes/${id}.json`
const localPath = (id: string) => `/local/notes/${id}.json`
const privateCopyMessage = 'Private note link copied. To share it with others, publish a public copy first.'
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

function row(id: string, title: string, content = `Text of ${title}`): NoteRecord {
  return {
    note: initializeNote({ id, title, content, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' }),
    published: null,
  }
}
function title() { return (screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value }
function content() { return (screen.getByRole('textbox', { name: 'Markdown content' }) as HTMLTextAreaElement).value }
function openPath(path: string) { window.history.replaceState(null, '', path) }
async function readyGuest() {
  await waitFor(() => expect((within(screen.getByRole('complementary')).getByRole('button', { name: 'Connect Pubky' }) as HTMLButtonElement).disabled).toBe(false))
}
async function login(session = alice) {
  const approval = deferred<Session>()
  mocks.start.mockResolvedValue({ authorizationUrl: 'pubkyring://authorize?request=links-test', awaitApproval: approval.promise, cancel: vi.fn() })
  fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: 'Connect Pubky' }))
  await screen.findByRole('link', { name: 'Open Pubky Ring' })
  await act(async () => { approval.resolve(session) })
}
async function seed(scope: string, rows: NoteRecord[], activeId = rows[0].note.id) {
  for (const record of rows) await writeLocalNote(scope, record)
  await setLocalActiveId(scope, activeId)
}

beforeEach(async () => {
  await closeLocalNotebook()
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  openPath('/')
  vi.clearAllMocks()
  mocks.restore.mockResolvedValue(null)
  mocks.persist.mockResolvedValue('stored-session')
  mocks.discard.mockResolvedValue(undefined)
  mocks.signOut.mockResolvedValue(undefined)
  mocks.list.mockResolvedValue([])
  mocks.save.mockImplementation(async (_session: Session, note: Note) => note)
  mocks.remove.mockImplementation(async (_session: Session, note: Note) => note)
  mocks.loadFolders.mockResolvedValue([])
  mocks.saveFolders.mockImplementation(async (_session: Session, folders: string[]) => folders)
  mocks.copy.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.copy } })
})

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await closeLocalNotebook()
  vi.unstubAllGlobals()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

describe('stable note links', () => {
  it('waits for a cold private target to arrive from the homeserver without selecting a cached default', async () => {
    const cached = row('cached-default', 'Cached default', 'Unrelated cached text')
    const requested = row('remote-target', 'Requested remote', 'The requested remote text')
    await seed(scopeForSession(alice), [cached])
    localStorage.setItem('pubky-notes:last-account:mainnet', scopeForSession(alice))
    const remote = deferred<NoteRecord[]>()
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockReturnValue(remote.promise)
    openPath(privatePath(requested.note.id))
    render(<App />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(alice))
    expect(screen.queryByRole('textbox', { name: 'Markdown content' })).toBeNull()
    expect(window.location.pathname).toBe(privatePath(requested.note.id))
    await act(async () => { remote.resolve([cached, requested]) })
    await waitFor(() => expect(title()).toBe('Requested remote'))
    expect(content()).toBe('The requested remote text')
    expect(window.location.pathname).toBe(privatePath(requested.note.id))
  })

  it('retains an unauthenticated private destination through login and remote loading', async () => {
    const requested = row('login-target', 'Requested after login')
    const remote = deferred<NoteRecord[]>()
    mocks.list.mockReturnValue(remote.promise)
    openPath(privatePath(requested.note.id))
    render(<App />)
    await readyGuest()
    expect(screen.queryByRole('textbox', { name: 'Markdown content' })).toBeNull()
    expect(window.location.pathname).toBe(privatePath(requested.note.id))
    await login()
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(alice))
    expect(window.location.pathname).toBe(privatePath(requested.note.id))
    expect(screen.queryByRole('textbox', { name: 'Markdown content' })).toBeNull()
    await act(async () => { remote.resolve([row('other-note', 'Other note'), requested]) })
    await waitFor(() => expect(title()).toBe('Requested after login'))
    expect(window.location.pathname).toBe(privatePath(requested.note.id))
  })

  it('does not open another account cache or a same-ID note while signed in as the wrong owner', async () => {
    const requested = row('same-id', 'Alice private', 'Private text belonging to Alice')
    const unrelated = row('same-id', 'Bob private', 'Different text belonging to Bob')
    await seed(scopeForSession(alice), [requested])
    await seed(scopeForSession(bob), [unrelated])
    localStorage.setItem('pubky-notes:last-account:mainnet', scopeForSession(bob))
    mocks.restore.mockResolvedValue(bob)
    mocks.list.mockResolvedValue([unrelated])
    openPath(privatePath(requested.note.id))
    render(<App />)
    await screen.findByRole('button', { name: 'Disconnect from Pubky' })
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(bob))
    expect(screen.queryByRole('textbox', { name: 'Markdown content' })).toBeNull()
    expect(screen.queryByText(requested.note.content)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open note Alice private' })).toBeNull()
    expect(window.location.pathname).toBe(privatePath(requested.note.id))
    expect(mocks.list.mock.calls.every(([session]) => session === bob)).toBe(true)
    expect(mocks.publicNote).not.toHaveBeenCalled()
  })

  it('keeps a missing private destination instead of falling back to another note', async () => {
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockResolvedValue([row('existing', 'Existing note')])
    openPath(privatePath('missing'))
    render(<App />)
    await screen.findByRole('heading', { name: 'Note not found' })
    expect(screen.queryByRole('textbox', { name: 'Markdown content' })).toBeNull()
    expect(window.location.pathname).toBe(privatePath('missing'))
    expect(mocks.publicNote).not.toHaveBeenCalled()
  })

  it('updates local note URLs and respects browser back, forward, and reload over the cached selection', async () => {
    const first = row('first-local', 'First local'), second = row('second-local', 'Second local')
    await seed(GUEST_SCOPE, [first, second], second.note.id)
    openPath(localPath(first.note.id))
    const view = render(<App />)
    await readyGuest()
    expect(title()).toBe('First local')
    fireEvent.click(screen.getByRole('button', { name: 'Open note Second local' }))
    await waitFor(() => expect(window.location.pathname).toBe(localPath(second.note.id)))
    expect(title()).toBe('Second local')
    await act(async () => { window.history.back() })
    await waitFor(() => expect(title()).toBe('First local'))
    expect(window.location.pathname).toBe(localPath(first.note.id))
    await act(async () => { window.history.forward() })
    await waitFor(() => expect(title()).toBe('Second local'))
    expect(window.location.pathname).toBe(localPath(second.note.id))
    view.unmount()
    await closeLocalNotebook()
    await setLocalActiveId(GUEST_SCOPE, first.note.id)
    render(<App />)
    await readyGuest()
    expect(title()).toBe('Second local')
    expect(window.location.pathname).toBe(localPath(second.note.id))
  })

  it('opens a trashed private target with its retained text and restore action', async () => {
    const original = row('trashed-target', 'Trashed target', 'Retained deleted text')
    const trashed = { ...original, note: editNote(original.note, { deleted: true }) }
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockResolvedValue([row('active-note', 'Active note'), trashed])
    openPath(privatePath(trashed.note.id))
    render(<App />)
    await screen.findByRole('button', { name: 'Restore' })
    expect(title()).toBe('Trashed target')
    expect(content()).toBe('Retained deleted text')
    expect(window.location.pathname).toBe(privatePath(trashed.note.id))
  })

  it('rewrites an adopted local link to the private ID assigned after an ID collision', async () => {
    const guest = row('collision', 'Guest draft', 'The draft to preserve')
    const existing = row('collision', 'Existing account note', 'Independent account history')
    await seed(GUEST_SCOPE, [guest])
    mocks.list.mockResolvedValue([existing])
    openPath(localPath(guest.note.id))
    render(<App />)
    await readyGuest()
    expect(title()).toBe('Guest draft')
    await login()
    await screen.findByRole('button', { name: 'Disconnect from Pubky' })
    await waitFor(async () => {
      const account = await readLocalNotebook(scopeForSession(alice))
      const adopted = account.records.find(record => record.note.content === guest.note.content)
      expect(adopted).toBeDefined()
      expect(adopted!.note.id).not.toBe(guest.note.id)
      expect(window.location.pathname).toBe(privatePath(adopted!.note.id))
      expect(content()).toBe(guest.note.content)
    })
    expect((await readLocalNotebook(GUEST_SCOPE)).records).toEqual([])
  })

  it.each(['canonical', 'legacy'] as const)('opens a %s public link through public storage without restoring a private session', async format => {
    const published = row('public-target', 'Public title', 'Public snapshot only').note
    mocks.publicNote.mockResolvedValue(published)
    openPath(format === 'canonical' ? publicPath(published.id) : `/?owner=${alice.info.publicKey.z32()}&note=${published.id}`)
    render(<App />)
    await screen.findByRole('heading', { name: 'Public title' })
    expect(screen.getByText('Public snapshot only')).toBeTruthy()
    expect(mocks.publicNote).toHaveBeenCalledExactlyOnceWith(alice.info.publicKey.z32(), published.id)
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('copies the published snapshot using its canonical public URL', async () => {
    const requested = row('published-copy', 'Published copy')
    requested.published = { ...requested.note, crdt: undefined }
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockResolvedValue([requested])
    openPath(privatePath(requested.note.id))
    render(<App />)
    await waitFor(() => expect(title()).toBe('Published copy'))
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy public note link' }))
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}${publicPath(requested.note.id)}`))
    expect(screen.queryByText(privateCopyMessage)).toBeNull()
  })

  it('copies a private permalink and briefly explains that sharing requires publication', async () => {
    const requested = row('copy-target', 'Copy target')
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockResolvedValue([requested])
    openPath(privatePath(requested.note.id))
    render(<App />)
    await waitFor(() => expect(title()).toBe('Copy target'))
    await screen.findByText('Saved to Pubky')
    fireEvent.click(screen.getByRole('button', { name: 'Copy note link' }))
    await screen.findByText(privateCopyMessage)
    expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}${privatePath(requested.note.id)}`)
    expect(screen.getByText(privateCopyMessage)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(screen.queryByText(privateCopyMessage)).toBeNull(), { timeout: 5000 })
  }, 7000)
})
