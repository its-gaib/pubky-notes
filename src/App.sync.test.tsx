// @vitest-environment jsdom

import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@synonymdev/pubky'
import App from './App'
import { editNote, initializeNote, LineageConflictError } from './lib/crdt'
import type { Note, NoteRecord } from './lib/notes'
import { GUEST_SCOPE, scopeForSession } from './lib/notebook-sync'
import { acknowledgeLocalNote, adoptGuestNotebook, closeLocalNotebook, readLocalNotebook, setLocalActiveId, writeLocalNote } from './lib/local-notebook'

configure({ asyncUtilTimeout: 3000 })

const mocks = vi.hoisted(() => ({
  restore: vi.fn(), start: vi.fn(), persist: vi.fn(), discard: vi.fn(), signOut: vi.fn(),
  list: vi.fn(), save: vi.fn(), publish: vi.fn(), unpublish: vi.fn(), remove: vi.fn(),
  loadFolders: vi.fn(), saveFolders: vi.fn(),
  adoptionGate: null as Promise<void> | null,
  adoptionStarted: vi.fn(),
  localWriteGate: null as Promise<void> | null,
  localWriteError: null as Error | null,
  localWriteStarted: vi.fn(),
}))

vi.mock('./lib/pubky', () => ({
  restoreSession: mocks.restore, startSignIn: mocks.start, persistSession: mocks.persist,
  discardSession: mocks.discard, signOut: mocks.signOut,
}))
vi.mock('./lib/notes', async importOriginal => ({
  ...await importOriginal<typeof import('./lib/notes')>(),
  listNotes: mocks.list, saveNote: mocks.save, publishNote: mocks.publish,
  unpublishNote: mocks.unpublish, deleteNote: mocks.remove,
}))
vi.mock('./lib/folder-store', async importOriginal => ({
  ...await importOriginal<typeof import('./lib/folder-store')>(),
  loadFolders: mocks.loadFolders, saveFolders: mocks.saveFolders,
}))
vi.mock('./lib/local-notebook', async importOriginal => {
  const actual = await importOriginal<typeof import('./lib/local-notebook')>()
  return {
    ...actual,
    writeLocalNote: async (...args: Parameters<typeof actual.writeLocalNote>) => {
      mocks.localWriteStarted(...args)
      const error = mocks.localWriteError
      if (mocks.localWriteGate) await mocks.localWriteGate
      if (error) throw error
      return actual.writeLocalNote(...args)
    },
    adoptGuestNotebook: async (...args: Parameters<typeof actual.adoptGuestNotebook>) => {
      mocks.adoptionStarted(...args)
      if (mocks.adoptionGate) await mocks.adoptionGate
      return actual.adoptGuestNotebook(...args)
    },
  }
})
vi.mock('./lib/profile', () => ({ loadProfile: vi.fn(async () => ({ name: 'Test account' })), loadAvatar: vi.fn() }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,cXI=') } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function identity(character: string): Session {
  return { info: { publicKey: { z32: () => character.repeat(52) } } } as unknown as Session
}
const alice = identity('y'), bob = identity('o')

function row(id: string, content = `Text of ${id}`): NoteRecord {
  return { note: initializeNote({ id: id.replaceAll(' ', '-'), title: id, content, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' }), published: null }
}

function title() { return (screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value }
function content() { return (screen.getByRole('textbox', { name: 'Markdown content' }) as HTMLTextAreaElement).value }
function changeContent(value: string) { fireEvent.change(screen.getByRole('textbox', { name: 'Markdown content' }), { target: { value } }) }
async function saveNow() { await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) }) }
async function readyGuest() {
  await waitFor(() => expect((screen.getByRole('button', { name: 'Connect Pubky' }) as HTMLButtonElement).disabled).toBe(false))
}
async function beginLogin() {
  const approval = deferred<Session>()
  const cancel = vi.fn()
  mocks.start.mockResolvedValue({ authorizationUrl: 'pubkyring://authorize?request=sync-test', awaitApproval: approval.promise, cancel })
  fireEvent.click(screen.getByRole('button', { name: 'Connect Pubky' }))
  await screen.findByRole('link', { name: 'Open Pubky Ring' })
  return { approval, cancel }
}
async function approve(approval: ReturnType<typeof deferred<Session>>, session = alice) {
  await act(async () => { approval.resolve(session) })
  await screen.findByRole('button', { name: 'Disconnect from Pubky' })
}

beforeEach(async () => {
  await closeLocalNotebook()
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
  mocks.adoptionGate = null
  mocks.localWriteGate = null
  mocks.localWriteError = null
  mocks.restore.mockResolvedValue(null)
  mocks.persist.mockResolvedValue('stored-session')
  mocks.discard.mockResolvedValue(undefined)
  mocks.signOut.mockResolvedValue(undefined)
  mocks.list.mockResolvedValue([])
  mocks.save.mockImplementation(async (_session: Session, note: Note) => note)
  mocks.remove.mockImplementation(async (_session: Session, note: Note) => note)
  mocks.loadFolders.mockResolvedValue([])
  mocks.saveFolders.mockImplementation(async (_session: Session, folders: string[]) => {
    mocks.loadFolders.mockResolvedValue(folders)
    return folders
  })
})

afterEach(async () => {
  cleanup()
  await closeLocalNotebook()
  vi.unstubAllGlobals()
})

describe('durable local notes and account synchronization', () => {
  it('keeps an untouched sample ephemeral, then restores an edited guest draft after a reload', async () => {
    const view = render(<App />)
    await readyGuest()
    expect((await readLocalNotebook(GUEST_SCOPE)).records).toEqual([])
    fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), { target: { value: 'Travel draft' } })
    changeContent('Words written before signing in.')
    await waitFor(async () => {
      const cache = await readLocalNotebook(GUEST_SCOPE)
      expect(cache.records[0]?.note.content).toBe('Words written before signing in.')
      expect(cache.records[0]?.note.title).toBe('Travel draft')
      expect(cache.activeId).toBe(cache.records[0]?.note.id)
    })
    view.unmount()
    await closeLocalNotebook()
    render(<App />)
    await readyGuest()
    expect(title()).toBe('Travel draft')
    expect(content()).toBe('Words written before signing in.')
    expect(screen.getByText('Saved on this device')).toBeTruthy()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('merges guest drafts with remote notes on login, keeps the open draft selected, and uploads it privately', async () => {
    mocks.list.mockResolvedValue([row('Remote note')])
    render(<App />)
    await readyGuest()
    fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), { target: { value: 'My local draft' } })
    changeContent('Keep my draft through login.')
    await waitFor(async () => expect((await readLocalNotebook(GUEST_SCOPE)).records[0]?.note.content).toBe('Keep my draft through login.'))
    const guestId = (await readLocalNotebook(GUEST_SCOPE)).records[0].note.id
    const { approval } = await beginLogin()
    await approve(approval)
    await screen.findByText('Saved to Pubky')
    expect(title()).toBe('My local draft')
    expect(content()).toBe('Keep my draft through login.')
    expect(screen.getByRole('button', { name: 'Open note Remote note' })).toBeTruthy()
    expect(mocks.save).toHaveBeenCalledWith(alice, expect.objectContaining({ id: guestId, content: 'Keep my draft through login.' }))
    expect(mocks.publish).not.toHaveBeenCalled()
    const account = await readLocalNotebook(scopeForSession(alice))
    expect(account.records).toHaveLength(2)
    expect(account.pending).toEqual([])
    expect(account.activeId).toBe(guestId)
    expect((await readLocalNotebook(GUEST_SCOPE)).records).toEqual([])
  }, 15_000) // Guest persistence, login/adoption, and private upload each perform asynchronous storage work.

  it('retains failed uploads locally and never reports them as saved to Pubky', async () => {
    mocks.save.mockRejectedValue(new Error('Homeserver rejected the write'))
    render(<App />)
    await readyGuest()
    changeContent('Offline edits must survive.')
    const { approval } = await beginLogin()
    await approve(approval)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Homeserver rejected the write'))
    expect(screen.queryByText('Saved to Pubky')).toBeNull()
    expect(screen.getByText('Saved on this device')).toBeTruthy()
    expect(content()).toBe('Offline edits must survive.')
    const cached = await readLocalNotebook(scopeForSession(alice))
    expect(cached.pending).toEqual([cached.records[0].note.id])
    expect(cached.records[0].note.content).toBe('Offline edits must survive.')
    expect((await readLocalNotebook(GUEST_SCOPE)).records).toEqual([])
    mocks.save.mockImplementation(async (_session: Session, note: Note) => note)
    await saveNow()
    await screen.findByText('Saved to Pubky')
    expect((await readLocalNotebook(scopeForSession(alice))).pending).toEqual([])
  })

  it('uploads a newly created guest note including its untouched Markdown template after login', async () => {
    render(<App />)
    await readyGuest()
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    await waitFor(() => expect(title()).toBe('Untitled note'))
    const template = content()
    expect(template).toContain('**Bold**')
    await waitFor(async () => expect((await readLocalNotebook(GUEST_SCOPE)).records).toHaveLength(1))
    const { approval } = await beginLogin()
    await approve(approval)
    await screen.findByText('Saved to Pubky')
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(alice, expect.objectContaining({ title: 'Untitled note', content: template }))
    expect(mocks.publish).not.toHaveBeenCalled()
    expect((await readLocalNotebook(scopeForSession(alice))).records).toHaveLength(1)
    expect((await readLocalNotebook(GUEST_SCOPE)).records).toEqual([])
  })

  it('preserves a newer edit when an older save completes, then uploads the remaining edit', async () => {
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockResolvedValue([row('Concurrent note', 'Original text')])
    render(<App />)
    await screen.findByText('Saved to Pubky')
    const upload = deferred<Note>()
    mocks.save.mockImplementationOnce(() => upload.promise)
    changeContent('First edit being uploaded')
    await saveNow()
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
    const sent = mocks.save.mock.calls[0][1] as Note
    changeContent('First edit being uploaded plus newer text')
    await waitFor(async () => expect((await readLocalNotebook(scopeForSession(alice))).records[0]?.note.content).toBe('First edit being uploaded plus newer text'))
    await act(async () => { upload.resolve(sent) })
    await waitFor(() => expect(content()).toBe('First edit being uploaded plus newer text'))
    const cached = await readLocalNotebook(scopeForSession(alice))
    expect(cached.pending).toEqual([sent.id])
    expect(screen.queryByText('Saved to Pubky')).toBeNull()
    await saveNow()
    await screen.findByText('Saved to Pubky')
    expect(mocks.save).toHaveBeenLastCalledWith(alice, expect.objectContaining({ content: 'First edit being uploaded plus newer text' }))
    expect((await readLocalNotebook(scopeForSession(alice))).pending).toEqual([])
  })

  it('keeps an account cache and subsequent edits in that account when session restoration fails', async () => {
    const cached = row('Alice private', 'Only Alice should receive this')
    await writeLocalNote(scopeForSession(alice), cached)
    await setLocalActiveId(scopeForSession(alice), cached.note.id)
    localStorage.setItem('pubky-notes:last-account:mainnet', scopeForSession(alice))
    mocks.restore.mockRejectedValue(new Error('Session temporarily unavailable'))
    render(<App />)
    await readyGuest()
    expect(title()).toBe('Alice private')
    changeContent('Alice edits while reconnecting')
    await waitFor(async () => expect((await readLocalNotebook(scopeForSession(alice))).records[0]?.note.content).toBe('Alice edits while reconnecting'))
    expect((await readLocalNotebook(GUEST_SCOPE)).records).toEqual([])
    mocks.list.mockResolvedValue([row('Bob private', 'Bob remote content')])
    const { approval } = await beginLogin()
    await approve(approval, bob)
    await screen.findByText('Saved to Pubky')
    expect(title()).toBe('Bob private')
    expect(screen.queryByRole('button', { name: 'Open note Alice private' })).toBeNull()
    expect((await readLocalNotebook(scopeForSession(alice))).pending).toEqual([cached.note.id])
    expect((await readLocalNotebook(scopeForSession(bob))).records.map(row => row.note.title)).toEqual(['Bob private'])
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('moves notes to durable Trash and restores their text without publishing', async () => {
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockResolvedValue([row('Recoverable note', 'Retain this text')])
    render(<App />)
    await screen.findByText('Saved to Pubky')
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Move note to Trash?' })).getByRole('button', { name: 'Move to Trash' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await saveNow()
    await waitFor(async () => expect((await readLocalNotebook(scopeForSession(alice))).pending).toEqual([]))
    expect(mocks.remove).toHaveBeenCalledWith(alice, expect.objectContaining({ deleted: true, content: 'Retain this text' }))
    expect((await readLocalNotebook(scopeForSession(alice))).records[0].note.deleted).toBe(true)
    // A deleted active link opens its retained copy in Trash; leaving this view
    // must remain possible without changing the retained note or its history.
    expect(screen.getByRole('navigation', { name: 'Deleted notes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))
    expect(screen.getByRole('navigation', { name: 'Folders and notes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Notebook options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Trash' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open note Recoverable note' }))
    expect(content()).toBe('Retain this text')
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(async () => expect((await readLocalNotebook(scopeForSession(alice))).records[0].note.deleted).not.toBe(true))
    await saveNow()
    await screen.findByText('Saved to Pubky')
    expect(content()).toBe('Retain this text')
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.save).toHaveBeenLastCalledWith(alice, expect.objectContaining({ content: 'Retain this text' }))
  })

  it('does not cancel a login after the atomic guest-adoption step has started', async () => {
    const adoption = deferred<void>()
    mocks.adoptionGate = adoption.promise
    render(<App />)
    await readyGuest()
    changeContent('Preserve this draft through the transition')
    const { approval, cancel } = await beginLogin()
    await act(async () => { approval.resolve(alice) })
    await waitFor(() => expect(mocks.adoptionStarted).toHaveBeenCalledWith(GUEST_SCOPE, scopeForSession(alice)))
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(cancel).not.toHaveBeenCalled()
    expect(mocks.discard).not.toHaveBeenCalled()
    await act(async () => { adoption.resolve() })
    await screen.findByRole('button', { name: 'Disconnect from Pubky' })
    await screen.findByText('Saved to Pubky')
    expect(content()).toBe('Preserve this draft through the transition')
    expect((await readLocalNotebook(GUEST_SCOPE)).records).toEqual([])
    expect((await readLocalNotebook(scopeForSession(alice))).pending).toEqual([])
  })

  it('routes newer typing from a stale signed-in tab into one durable recovery note', async () => {
    const original = row('Shared history', 'Original private text')
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockResolvedValue([original])
    render(<App />)
    await screen.findByText('Saved to Pubky')
    const replacement = row('Shared history', 'Independent replacement text')
    const recovered = (await acknowledgeLocalNote(scopeForSession(alice), replacement)).recovered!
    const write = deferred<void>()
    mocks.localWriteGate = write.promise
    mocks.localWriteStarted.mockClear()
    changeContent('First stale-tab edit')
    await waitFor(() => expect(mocks.localWriteStarted).toHaveBeenCalledOnce())
    changeContent('First stale-tab edit and newer typing')
    expect(screen.queryByText('Saved to Pubky')).toBeNull()
    await act(async () => { write.resolve() })
    await waitFor(async () => {
      const cache = await readLocalNotebook(scopeForSession(alice))
      expect(cache.records).toHaveLength(2)
      expect(cache.records.find(record => record.note.id === recovered.note.id)?.note.content).toBe('First stale-tab edit and newer typing')
      expect(content()).toBe('First stale-tab edit and newer typing')
      expect(title()).toContain('(recovered)')
    })
    expect((await readLocalNotebook(scopeForSession(alice))).records.find(record => record.note.id === original.note.id)?.note.content).toBe('Independent replacement text')
    expect(mocks.publish).not.toHaveBeenCalled()
    await saveNow()
    await screen.findByText('Saved to Pubky')
    expect((await readLocalNotebook(scopeForSession(alice))).activeId).toBe(recovered.note.id)
    expect((await readLocalNotebook(scopeForSession(alice))).records).toHaveLength(2)
  })

  it('retains newer volatile recovery edits when their local commit fails', async () => {
    const original = row('Recover safely', 'Original text')
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockResolvedValue([original])
    render(<App />)
    await screen.findByText('Saved to Pubky')
    const recovered = (await acknowledgeLocalNote(scopeForSession(alice), row('Recover safely', 'Replacement'))).recovered!
    const write = deferred<void>()
    mocks.localWriteGate = write.promise
    mocks.localWriteStarted.mockClear()
    changeContent('First durable edit')
    await waitFor(() => expect(mocks.localWriteStarted).toHaveBeenCalledOnce())
    mocks.localWriteError = new Error('Local disk unavailable')
    changeContent('First durable edit plus unsaved typing')
    await act(async () => { write.resolve() })
    await screen.findByText('Not saved on this device')
    expect(content()).toBe('First durable edit plus unsaved typing')
    expect(screen.queryByText('Saved to Pubky')).toBeNull()
    expect(screen.queryByText('Saved on this device')).toBeNull()
    expect((await readLocalNotebook(scopeForSession(alice))).records.find(record => record.note.id === recovered.note.id)?.note.content).toBe('First durable edit')
    mocks.localWriteError = null
    await saveNow()
    await screen.findByText('Saved to Pubky')
    const cache = await readLocalNotebook(scopeForSession(alice))
    expect(cache.records).toHaveLength(2)
    expect(cache.records.find(record => record.note.id === recovered.note.id)?.note.content).toBe('First durable edit plus unsaved typing')
    expect(cache.pending).toEqual([])
  })

  it('uses the exact recovery mapping instead of another note sharing the same lineage', async () => {
    const original = row('Exact source', 'Source text')
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockResolvedValue([original])
    render(<App />)
    await screen.findByText('Saved to Pubky')
    const replacement = row('Exact source', 'Replacement text')
    const recovered = (await acknowledgeLocalNote(scopeForSession(alice), replacement)).recovered!
    const unrelated = { note: editNote({ ...original.note, id: 'unrelated-copy' }, { title: 'Other copy', content: 'Keep this copy separate' }), published: null }
    await acknowledgeLocalNote(scopeForSession(alice), unrelated)
    mocks.list.mockResolvedValue([replacement, unrelated])
    fireEvent.click(screen.getByRole('button', { name: 'Notebook options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh notes' }))
    await waitFor(() => expect(title()).toBe('Exact source (recovered)'))
    expect(content()).toBe('Source text')
    const cache = await readLocalNotebook(scopeForSession(alice))
    expect(cache.records).toHaveLength(3)
    expect(cache.records.find(record => record.note.id === unrelated.note.id)?.note.content).toBe('Keep this copy separate')
    changeContent('Source text continued')
    await waitFor(async () => expect((await readLocalNotebook(scopeForSession(alice))).records.find(record => record.note.id === recovered.note.id)?.note.content).toBe('Source text continued'))
  })

  it('keeps a claimed guest recovery and newer typing out of a later account login', async () => {
    render(<App />)
    await readyGuest()
    changeContent('Guest text claimed by Alice')
    await screen.findByText('Saved on this device')
    const guest = (await readLocalNotebook(GUEST_SCOPE)).records[0]
    await adoptGuestNotebook(GUEST_SCOPE, scopeForSession(alice))
    const replacement = row('Replacement', 'Alice replacement')
    replacement.note.id = guest.note.id
    const recovered = (await acknowledgeLocalNote(scopeForSession(alice), replacement)).recovered!
    const write = deferred<void>()
    mocks.localWriteGate = write.promise
    mocks.localWriteStarted.mockClear()
    changeContent('Claimed guest first edit')
    await waitFor(() => expect(mocks.localWriteStarted).toHaveBeenCalledOnce())
    changeContent('Claimed guest first edit and newer typing')
    await act(async () => { write.resolve() })
    await waitFor(async () => expect((await readLocalNotebook(scopeForSession(alice))).records.find(record => record.note.id === recovered.note.id)?.note.content).toBe('Claimed guest first edit and newer typing'))
    expect((await readLocalNotebook(GUEST_SCOPE)).records).toEqual([])
    mocks.list.mockResolvedValue([row('Bob private', 'Only Bob content')])
    const { approval } = await beginLogin()
    await approve(approval, bob)
    await screen.findByText('Saved to Pubky')
    expect(title()).toBe('Bob private')
    expect((await readLocalNotebook(scopeForSession(bob))).records.map(record => record.note.content)).toEqual(['Only Bob content'])
    expect((await readLocalNotebook(GUEST_SCOPE)).records).toEqual([])
    expect(mocks.save.mock.calls.some(([session]) => session === bob)).toBe(false)
  })

  it('recovers a replacement history privately and requires a new publish action', async () => {
    const original = row('Reviewed note', 'Text the user reviewed')
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockResolvedValue([original])
    render(<App />)
    await screen.findByText('Saved to Pubky')
    mocks.list.mockResolvedValue([row('Reviewed note', 'Unseen private replacement')])
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(screen.getByRole('button', { name: 'Publish public copy' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('choose Share again'))
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(content()).toBe('Text the user reviewed')
    expect(title()).toBe('Reviewed note (recovered)')
    const cache = await readLocalNotebook(scopeForSession(alice))
    expect(cache.records).toHaveLength(2)
    expect(cache.records.every(record => record.published === null)).toBe(true)
    expect(cache.records.map(record => record.note.content).sort()).toEqual(['Text the user reviewed', 'Unseen private replacement'])
  })

  it('does not retry publication when a history replacement races the publish request', async () => {
    const original = row('Race note', 'Reviewed public text')
    mocks.restore.mockResolvedValue(alice)
    mocks.list.mockResolvedValue([original])
    mocks.publish.mockImplementation(async () => {
      mocks.list.mockResolvedValue([row('Race note', 'Unseen private text')])
      throw new LineageConflictError()
    })
    render(<App />)
    await screen.findByText('Saved to Pubky')
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(screen.getByRole('button', { name: 'Publish public copy' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('choose Share again'))
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(alice, expect.objectContaining({ id: original.note.id, content: 'Reviewed public text' }))
    expect(content()).toBe('Reviewed public text')
    const cache = await readLocalNotebook(scopeForSession(alice))
    expect(cache.records).toHaveLength(2)
    expect(cache.records.every(record => record.published === null)).toBe(true)
  })
})
