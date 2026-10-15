// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCollaboration } from './useCollaboration'
import { initializeNote, listNoteVersions, readNoteVersion, readNoteVersionChanges } from '../lib/crdt'
import { createSharedNote, joinSharedNote, SharedNoteDocument } from '../lib/shared-note'
import type { CollaborationCallbacks, StoredRoom } from '../lib/collaboration'
import type { Invitation } from '../lib/collaboration'
import { encodeBytes, invitationUrl as actualInvitationUrl, parseInvitation as actualParseInvitation } from '../lib/collaboration/credentials'
import { PENDING_INVITATION_KEY, readPendingInvitation, savePendingInvitation } from '../lib/collaboration/pending-invitation'
import { decodePresence } from '../lib/collaboration/presence'
import type { CrdtNote } from '../lib/crdt'

const mocks = vi.hoisted(() => ({ start: vi.fn(), load: vi.fn(), create: vi.fn(), guest: vi.fn(), parse: vi.fn(), available: vi.fn(), send: vi.fn(), dispose: vi.fn(), reconnect: vi.fn() }))
vi.mock('../lib/collaboration', () => ({
  startCollaboration: mocks.start, loadRoom: mocks.load, createHostRoom: mocks.create,
  fingerprint: async () => 'OWN FINGERPRINT', invitationUrl: () => 'https://example.com/#collaborate=test',
  parseInvitation: mocks.parse, createGuestRoom: mocks.guest,
  webRtcAvailable: mocks.available, WEBRTC_UNAVAILABLE_MESSAGE: 'WebRTC is unavailable in this browser.',
  IDENTITY_UNAVAILABLE_MESSAGE: 'Sign in again with Pubky to verify your identity before collaborating.',
}))

const identity = { owner: 'y'.repeat(52), createProof: async () => ({ grant: 'unit-test-grant', pop: 'unit-test-proof' }) }
let callbacks: CollaborationCallbacks
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('crypto', webcrypto)
  sessionStorage.clear(); window.history.replaceState(null, '', '/')
  mocks.available.mockReset().mockReturnValue(true)
  mocks.parse.mockReset().mockReturnValue(null)
  mocks.create.mockReset(); mocks.guest.mockReset()
  mocks.send.mockReset().mockResolvedValue(undefined)
  mocks.dispose.mockReset(); mocks.load.mockReset().mockResolvedValue(null)
  mocks.reconnect.mockReset()
  mocks.start.mockReset().mockImplementation((_room: StoredRoom, next: CollaborationCallbacks) => {
    callbacks = next
    return { send: mocks.send, dispose: mocks.dispose, approve: vi.fn(), reject: vi.fn(), reconnect: mocks.reconnect }
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function pendingInvite(seed = 1): Invitation {
  return { version: 1, room: encodeBytes(new Uint8Array(24).fill(seed)), secret: encodeBytes(new Uint8Array(32).fill(seed)), hostKey: encodeBytes(new Uint8Array(65).fill(seed)),
    descriptor: { id: `invited-note-${seed}`, createdAt: '2026-10-15T00:00:00.000Z', lineage: 'shared:00000000-0000-4000-8000-000000000001' } }
}
function openInvitation(invite: Invitation) {
  mocks.parse.mockImplementation(actualParseInvitation)
  window.history.replaceState(null, '', actualInvitationUrl(invite, window.location.origin))
}

describe('pending collaboration invitations', () => {
  it('survives login scope changes and reload, and joins only after an explicit click', async () => {
    const invite = pendingInvite()
    openInvitation(invite)
    const options = { identity, scope: 'mainnet:guest', enabled: false, notes: [] as CrdtNote[], persist: vi.fn(async () => {}), beforeRemoteChange: () => undefined }
    const guest = renderHook(value => useCollaboration(value), { initialProps: options })
    expect(guest.result.current.invitation).toEqual(invite)
    expect(window.location.hash).toBe('')
    expect(readPendingInvitation()).toEqual(invite)
    guest.rerender({ ...options, scope: 'mainnet:alice', enabled: true })
    expect(guest.result.current.invitation).toEqual(invite)
    expect(mocks.start).not.toHaveBeenCalled()
    guest.unmount()
    const signedIn = renderHook(() => useCollaboration({ ...options, scope: 'mainnet:alice', enabled: true }))
    expect(signedIn.result.current.invitation).toEqual(invite)
    expect(mocks.start).not.toHaveBeenCalled()
    const room = { ...invite, scope: 'mainnet:alice', role: 'guest', identity: { publicKey: 'key' } } as StoredRoom
    mocks.guest.mockResolvedValue(room)
    await act(async () => { await signedIn.result.current.join() })
    expect(mocks.guest).toHaveBeenCalledWith('mainnet:alice', invite)
    expect(mocks.start).toHaveBeenCalledWith(room, expect.any(Object), { identity })
    expect(signedIn.result.current.invitation).toBeNull()
    expect(sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull()
    expect(window.location.hash).toBe('')
  })

  it('does not re-open a dismissed invitation after reload', () => {
    const invite = pendingInvite()
    openInvitation(invite)
    const options = { identity, scope: 'mainnet:guest', enabled: false, notes: [], persist: vi.fn(async () => {}), beforeRemoteChange: () => undefined }
    const first = renderHook(() => useCollaboration(options))
    act(() => first.result.current.dismissInvitation())
    expect(readPendingInvitation()).toBeNull()
    first.unmount()
    const second = renderHook(() => useCollaboration(options))
    expect(second.result.current.invitation).toBeNull()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('cancels an in-flight join on account change without consuming the invitation', async () => {
    const invite = pendingInvite()
    openInvitation(invite)
    let finish!: (room: StoredRoom) => void
    mocks.guest.mockImplementation(() => new Promise<StoredRoom>(resolve => { finish = resolve }))
    const options = { identity, scope: 'mainnet:alice', enabled: true, notes: [] as CrdtNote[], persist: vi.fn(async () => {}), beforeRemoteChange: () => undefined }
    const hook = renderHook(value => useCollaboration(value), { initialProps: options })
    let joining!: Promise<void>
    await act(async () => { joining = hook.result.current.join(); await Promise.resolve() })
    hook.rerender({ ...options, scope: 'mainnet:bob' })
    await act(async () => { finish({ ...invite, scope: 'mainnet:alice', role: 'guest', identity: { publicKey: 'key' } } as StoredRoom); await joining })
    expect(mocks.start).not.toHaveBeenCalled()
    expect(hook.result.current.invitation).toEqual(invite)
    expect(readPendingInvitation()).toEqual(invite)
  })

  it('does not consume a replacement invitation when an older join finishes', async () => {
    const first = pendingInvite(1), next = pendingInvite(2)
    openInvitation(first)
    let finish!: (room: StoredRoom) => void
    mocks.guest.mockImplementation(() => new Promise<StoredRoom>(resolve => { finish = resolve }))
    const hook = renderHook(() => useCollaboration({ identity, scope: 'mainnet:alice', enabled: true, notes: [], persist: vi.fn(async () => {}), beforeRemoteChange: () => undefined }))
    let joining!: Promise<void>
    await act(async () => { joining = hook.result.current.join(); await Promise.resolve() })
    act(() => { openInvitation(next); window.dispatchEvent(new HashChangeEvent('hashchange')) })
    await act(async () => { finish({ ...first, scope: 'mainnet:alice', role: 'guest', identity: { publicKey: 'key' } } as StoredRoom); await joining })
    expect(mocks.start).not.toHaveBeenCalled()
    expect(hook.result.current.invitation).toEqual(next)
    expect(readPendingInvitation()).toEqual(next)
  })

  it('clears invalid links and does not join a conflicting local note', async () => {
    savePendingInvitation(pendingInvite())
    mocks.parse.mockImplementation(actualParseInvitation)
    window.history.replaceState(null, '', '/#collaborate=invalid')
    const options = { identity, scope: 'mainnet:alice', enabled: true, notes: [] as CrdtNote[], persist: vi.fn(async () => {}), beforeRemoteChange: () => undefined }
    const invalid = renderHook(() => useCollaboration(options))
    expect(invalid.result.current.invitation).toBeNull()
    expect(invalid.result.current.view.error).toContain('invalid')
    expect(readPendingInvitation()).toBeNull()
    expect(window.location.hash).toBe('')
    invalid.unmount()
    const invite = pendingInvite()
    openInvitation(invite)
    const conflicting = initializeNote({ id: invite.descriptor.id, title: 'Private', content: 'Unrelated', createdAt: invite.descriptor.createdAt, updatedAt: invite.descriptor.createdAt })
    const hook = renderHook(() => useCollaboration({ ...options, notes: [conflicting] }))
    await expect(hook.result.current.join()).rejects.toThrow('conflicts with another note')
    expect(mocks.guest).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(readPendingInvitation()).toEqual(invite)
  })
})

async function setup(presenceSupported = true, remapNotes = false) {
  const shared = createSharedNote(initializeNote({ id: 'source', title: 'Meeting', content: 'Hello world', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' }))
  const room = { scope: 'alice', role: 'host', descriptor: { id: shared.id, lineage: shared.crdt!.lineage, createdAt: shared.createdAt }, identity: { publicKey: 'key' } } as StoredRoom
  mocks.create.mockResolvedValue(room)
  const persist = vi.fn(async (_note: CrdtNote, _scope: string, _select?: boolean) => {})
  const beforeRemoteChange = vi.fn<(_doc: SharedNoteDocument, _rendered?: SharedNoteDocument) => (() => void) | undefined>(() => undefined)
  const props = { identity, scope: 'alice', enabled: true, notes: [shared], activeId: shared.id, displayName: 'Alice', editorId: 'pubky:alice', persist, beforeRemoteChange }
  let renders = 0
  const hook = renderHook(options => {
    // Fail promptly instead of hanging the test if a state/effect feedback loop regresses.
    if (++renders > 100) throw new Error('Collaboration did not settle after rendering.')
    return useCollaboration(remapNotes ? { ...options, notes: options.notes.map(note => note) } : options)
  }, { initialProps: props })
  await act(async () => { await hook.result.current.start(shared) })
  await act(async () => { callbacks.onStatus({ state: 'connected', relayAvailable: false, peerFingerprint: 'PEER KEY', presenceSupported }) })
  persist.mockClear(); mocks.send.mockClear()
  const peer = new SharedNoteDocument(shared)
  const presence = (start = 6, end = start) => {
    const json = new TextEncoder().encode(JSON.stringify({ selection: { ...peer.captureSelection('content', start, end), direction: 'forward' }, label: 'Bob' }))
    return new Uint8Array([3, ...json])
  }
  return { ...hook, shared, props, persist, beforeRemoteChange, peer, presence, renders: () => renders }
}

describe('collaboration cursor hook', () => {
  it('requires identity proof support before creating a shared copy', async () => {
    const source = initializeNote({ id: 'private', title: 'Private', content: 'Keep private', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' })
    const persist = vi.fn()
    const { result } = renderHook(() => useCollaboration({ scope: 'alice', enabled: true, notes: [source], persist, beforeRemoteChange: () => undefined }))
    await expect(result.current.start(source)).rejects.toThrow('Sign in again with Pubky')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it('retains an invitation when the session cannot prove its identity', async () => {
    openInvitation(pendingInvite())
    const { result } = renderHook(() => useCollaboration({ scope: 'alice', enabled: true, notes: [], persist: vi.fn(), beforeRemoteChange: () => undefined }))
    await expect(result.current.join()).rejects.toThrow('Sign in again with Pubky')
    expect(result.current.invitation).not.toBeNull()
    expect(readPendingInvitation()).not.toBeNull()
    expect(mocks.guest).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('does not create or persist a shared copy when WebRTC is unavailable', async () => {
    mocks.available.mockReturnValue(false)
    const source = initializeNote({ id: 'private', title: 'Private', content: 'Keep private', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' })
    const persist = vi.fn()
    const { result } = renderHook(() => useCollaboration({ identity, scope: 'alice', enabled: true, notes: [source], activeId: source.id, persist, beforeRemoteChange: () => undefined }))
    await expect(result.current.start(source)).rejects.toThrow('WebRTC is unavailable')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it('does not consume or create a guest room for an invitation when WebRTC is unavailable', async () => {
    mocks.available.mockReturnValue(false)
    mocks.parse.mockReturnValue({ descriptor: { id: 'shared' } })
    const persist = vi.fn()
    const { result } = renderHook(() => useCollaboration({ identity, scope: 'alice', enabled: true, notes: [], persist, beforeRemoteChange: () => undefined }))
    await expect(result.current.join()).rejects.toThrow('WebRTC is unavailable')
    expect(result.current.invitation).not.toBeNull()
    expect(mocks.guest).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it('pauses automatic room resume without WebRTC and can retry after support returns', async () => {
    mocks.available.mockReturnValue(false)
    const shared = createSharedNote(initializeNote({ id: 'source', title: 'Note', content: 'Text', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' }))
    const room = { scope: 'alice', role: 'host', descriptor: { id: shared.id, lineage: shared.crdt!.lineage, createdAt: shared.createdAt }, identity: { publicKey: 'key' } } as StoredRoom
    mocks.load.mockResolvedValue(room)
    const options = { identity, scope: 'alice', enabled: true, notes: [shared], activeId: shared.id, persist: vi.fn(async () => {}), beforeRemoteChange: () => undefined }
    const { result } = renderHook(() => useCollaboration(options))
    await act(async () => {})
    expect(result.current.view.status?.issue).toBe('webrtc-unavailable')
    expect(mocks.start).not.toHaveBeenCalled()
    expect(options.persist).not.toHaveBeenCalled()
    mocks.available.mockReturnValue(true)
    await act(async () => { result.current.reconnect() })
    expect(mocks.start).toHaveBeenCalledOnce()
  })

  it('retains each editor on a mixed checkpoint and attributes a restore to the restoring editor', async () => {
    const { result, peer, shared } = await setup()
    const initialId = listNoteVersions(shared)[0].id
    peer.edit({ content: 'Hello world from Bob' }, { id: 'pubky:bob', label: 'Bob' })
    await act(async () => { await callbacks.onMessage(new Uint8Array([1, ...peer.getUpdate()])) })
    let changed = shared
    // Alice edits a stale rendered snapshot; Bob's unseen suffix is retained.
    act(() => { changed = result.current.edit(shared, { content: 'Hi world' }) })
    act(() => { changed = result.current.checkpoint(changed) })
    const changes = readNoteVersionChanges(changed, listNoteVersions(changed).at(-1)!.id)
    expect(new Set(changes.edits.map(edit => edit.author?.label))).toEqual(new Set(['Alice', 'Bob']))
    expect(changes.edits.find(edit => edit.author?.label === 'Alice')?.changes.some(change => change.deleted)).toBe(true)
    let restored = changed
    act(() => { restored = result.current.restoreVersion(changed, initialId) })
    const restoredChanges = readNoteVersionChanges(restored, listNoteVersions(restored).at(-1)!.id)
    expect(restoredChanges.edits.map(edit => edit.author?.label)).toEqual(['Alice'])
    peer.destroy()
  })

  it('restores against the latest live text and retains unseen peer work as a private version', async () => {
    const { result, peer, shared } = await setup()
    const originalId = listNoteVersions(shared)[0].id
    peer.edit({ content: 'Peer work received before React renders' })
    await act(async () => { await callbacks.onMessage(new Uint8Array([1, ...peer.getUpdate()])) })
    let restored = shared
    act(() => { restored = result.current.restoreVersion(shared, originalId) })
    expect(restored.content).toBe(shared.content)
    const versions = listNoteVersions(restored)
    expect(versions).toHaveLength(3)
    expect(readNoteVersion(restored, versions[1].id).content).toBe('Peer work received before React renders')
    expect(versions.at(-1)?.restoredFrom).toBe(originalId)
    const update = mocks.send.mock.calls.findLast(([message]) => message[0] === 1)![0].subarray(1)
    peer.applyPeerUpdate(update)
    expect(peer.note.content).toBe(shared.content)
    expect(listNoteVersions(peer.note)).toHaveLength(1)
    peer.destroy()
  })

  it('keeps checkpoints private and preserves them across later live edits', async () => {
    const { result, peer, shared } = await setup()
    let changed = shared
    act(() => { changed = result.current.edit(shared, { content: 'Saved locally' }) })
    mocks.send.mockClear()
    act(() => { changed = result.current.checkpoint(changed) })
    expect(mocks.send).not.toHaveBeenCalled()
    expect(listNoteVersions(changed)).toHaveLength(2)
    act(() => { changed = result.current.edit(changed, { content: 'Next text' }) })
    expect(listNoteVersions(changed)).toHaveLength(2)
    expect(readNoteVersion(changed, listNoteVersions(changed)[1].id).content).toBe('Saved locally')
    peer.destroy()
  })

  it('clears a stale connection error on manual retry without restarting a stopped room', async () => {
    const { result, peer } = await setup()
    act(() => { callbacks.onError(new Error('Signaling is disconnected')) })
    expect(result.current.view.error).toBe('Signaling is disconnected')
    act(() => { result.current.reconnect() })
    expect(result.current.view.error).toBeUndefined()
    expect(mocks.reconnect).toHaveBeenCalledOnce()
    act(() => { result.current.stop() })
    act(() => { result.current.reconnect() })
    expect(mocks.reconnect).toHaveBeenCalledOnce()
    peer.destroy()
  })

  it('keeps an unseen peer edit when a local input is based on the previous rendered note', async () => {
    const { result, peer, shared } = await setup()
    // The live Yjs document receives Bob's suffix before React commits that
    // updated value. Alice's native input still edits the previous DOM value.
    peer.edit({ content: `${shared.content}\nBob` })
    await act(async () => { await callbacks.onMessage(new Uint8Array([1, ...peer.getUpdate()])) })
    let changed = shared
    act(() => { changed = result.current.edit(shared, { content: `Alice\n${shared.content}` }) })
    expect(changed.content).toBe(`Alice\n${shared.content}\nBob`)
    const update = mocks.send.mock.calls.findLast(([message]) => message[0] === 1)![0].subarray(1)
    peer.applyPeerUpdate(update)
    expect(peer.note.content).toBe(changed.content)
    peer.destroy()
  })

  it('rebases local deletions and title edits without deleting unseen peer additions', async () => {
    const { result, peer, shared } = await setup()
    peer.edit({ content: `${shared.content}\nBob`, title: `${shared.title} Bob` })
    await act(async () => { await callbacks.onMessage(new Uint8Array([1, ...peer.getUpdate()])) })
    let changed = shared
    act(() => { changed = result.current.edit(shared, { content: 'Hello ', title: `Alice ${shared.title}` }) })
    expect(changed).toMatchObject({ content: 'Hello \nBob', title: 'Alice Meeting Bob' })
    peer.destroy()
  })

  it('retains latest personal metadata, applies explicit personal patches causally, and never sends it to a peer', async () => {
    const { result, peer, shared } = await setup()
    act(() => { result.current.edit(shared, { folder: 'Latest/private', deleted: true }) })
    peer.edit({ content: `${shared.content}\nBob` })
    await act(async () => { await callbacks.onMessage(new Uint8Array([1, ...peer.getUpdate()])) })
    let changed = shared
    act(() => { changed = result.current.edit(shared, { content: `Alice\n${shared.content}` }) })
    expect(changed).toMatchObject({ folder: 'Latest/private', deleted: true, content: `Alice\n${shared.content}\nBob` })
    act(() => { changed = result.current.edit(shared, { folder: 'Requested/folder', deleted: false }) })
    expect(changed).toMatchObject({ folder: 'Requested/folder', content: `Alice\n${shared.content}\nBob` })
    expect(changed.deleted).not.toBe(true)
    const publicDoc = new SharedNoteDocument(changed)
    const joined = joinSharedNote(publicDoc.descriptor, publicDoc.getUpdate())
    expect(joined.folder).toBeUndefined(); expect(joined.deleted).not.toBe(true)
    publicDoc.destroy(); peer.destroy()
  })

  it('maps a local post-input caret from its rendered snapshot into the advanced document and publishes that position', async () => {
    const { result, peer, shared, beforeRemoteChange } = await setup()
    peer.edit({ content: `Bob ${shared.content}` })
    await act(async () => { await callbacks.onMessage(new Uint8Array([1, ...peer.getUpdate()])) })
    let resolved: { start: number; end: number } | null = null
    beforeRemoteChange.mockImplementation((live, rendered) => {
      if (!rendered) return
      const anchor = rendered.captureSelection('content', shared.content.length + 1)
      return () => { resolved = live.resolveSelection(anchor) }
    })
    let changed = shared
    act(() => { changed = result.current.edit(shared, { content: `${shared.content}!` }) })
    expect(changed.content).toBe(`Bob ${shared.content}!`)
    expect(resolved).toEqual({ start: changed.content.length, end: changed.content.length })
    await act(async () => { result.current.updateSelection(shared.id, { field: 'content', ...resolved! }); await vi.advanceTimersByTimeAsync(50) })
    const packet = mocks.send.mock.calls.findLast(([message]) => message[0] === 3)![0]
    const selection = decodePresence(packet.subarray(1))!.selection!
    const document = new SharedNoteDocument(changed)
    expect(document.resolveSelection(selection)).toEqual(resolved)
    document.destroy(); peer.destroy()
  })

  it('rejects an invalid rebased personal patch before committing its shared text changes', async () => {
    const { result, peer, shared } = await setup()
    peer.edit({ content: `${shared.content}\nBob` })
    await act(async () => { await callbacks.onMessage(new Uint8Array([1, ...peer.getUpdate()])) })
    expect(() => result.current.edit(shared, { content: 'Must not commit', folder: '../invalid' })).toThrow()
    let unchanged = shared
    act(() => { unchanged = result.current.edit(shared, {}) })
    expect(unchanged.content).toBe(`${shared.content}\nBob`)
    peer.destroy()
  })

  it('updates the editor and schedules restoration before yielding, then acknowledges the exact saved snapshot', async () => {
    const { result, peer, persist, beforeRemoteChange } = await setup()
    const restore = vi.fn()
    beforeRemoteChange.mockReturnValue(restore)
    let finishSave!: () => void
    persist.mockImplementationOnce(() => new Promise<void>(resolve => { finishSave = resolve }))
    const hash = vi.spyOn(crypto.subtle, 'digest')
    peer.edit({ content: `Prefix ${peer.note.content}` })
    const received = peer.getUpdate()
    let receiving!: Promise<void>
    act(() => { receiving = Promise.resolve(callbacks.onMessage(new Uint8Array([1, ...received]))) })
    expect(persist).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
    expect(hash).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    // A later local edit while saving must not change which checkpoint is acknowledged.
    act(() => { result.current.edit(persist.mock.calls[0][0], { content: 'A later local change' }) })
    await act(async () => { finishSave(); await receiving })
    expect(hash).toHaveBeenCalledWith('SHA-256', received)
    const acknowledgements = mocks.send.mock.calls.filter(([message]) => message[0] === 2)
    expect(acknowledgements).toHaveLength(1)
    peer.destroy()
  })

  it('restores selection on duplicate checkpoints without repeating their durable save', async () => {
    const { peer, persist, beforeRemoteChange } = await setup()
    let latestTicket = 0, pendingRestore: (() => void) | undefined, restored = 0
    beforeRemoteChange.mockImplementation(() => {
      const ticket = ++latestTicket
      return () => { pendingRestore = () => { if (ticket === latestTicket) restored++ } }
    })
    peer.edit({ content: 'A peer update' })
    const packet = new Uint8Array([1, ...peer.getUpdate()])
    await act(async () => { await callbacks.onMessage(packet); await callbacks.onMessage(packet) })
    expect(persist).toHaveBeenCalledOnce()
    expect(beforeRemoteChange).toHaveBeenCalledTimes(2)
    pendingRestore?.()
    expect(restored).toBe(1)
    peer.destroy()
  })

  it('does not acknowledge a failed save and retries an identical checkpoint', async () => {
    const { peer, persist } = await setup()
    persist.mockRejectedValueOnce(new Error('Storage unavailable'))
    peer.edit({ content: 'Unsaved peer update' })
    const packet = new Uint8Array([1, ...peer.getUpdate()])
    await act(async () => { await expect(callbacks.onMessage(packet)).rejects.toThrow('Storage unavailable') })
    expect(mocks.send.mock.calls.filter(([message]) => message[0] === 2)).toHaveLength(0)
    await act(async () => { await callbacks.onMessage(packet) })
    expect(persist).toHaveBeenCalledTimes(2)
    expect(mocks.send.mock.calls.filter(([message]) => message[0] === 2)).toHaveLength(1)
    peer.destroy()
  })

  it('settles with freshly mapped notes on every render and preserves identical cursor state', async () => {
    const { result, shared, persist, peer, presence, renders } = await setup(true, true)
    const before = renders()
    await act(async () => { await callbacks.onMessage(presence(6, 11)); await vi.advanceTimersByTimeAsync(50) })
    expect(result.current.remoteSelection).toMatchObject({ noteId: shared.id, start: 6, end: 11 })
    expect(renders() - before).toBeLessThanOrEqual(3)
    const first = result.current.remoteSelection
    await act(async () => { await callbacks.onMessage(presence(6, 11)); await vi.advanceTimersByTimeAsync(50) })
    expect(result.current.remoteSelection).toBe(first)
    await act(async () => { await callbacks.onMessage(presence(2, 5)); await vi.advanceTimersByTimeAsync(50) })
    expect(result.current.remoteSelection).toMatchObject({ start: 2, end: 5 })
    expect(result.current.remoteSelection).not.toBe(first)
    expect(persist).not.toHaveBeenCalled()
    peer.destroy()
  })

  it('sends and receives ephemeral cursor packets without saving or acknowledging notes', async () => {
    const { result, shared, persist, peer, presence } = await setup()
    const original = JSON.stringify(shared)
    await act(async () => {
      for (let i = 0; i < 100; i++) result.current.updateSelection(shared.id, { field: 'content', start: i % 10, end: i % 10 })
      await callbacks.onMessage(presence(6, 11))
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(mocks.send).toHaveBeenCalledOnce()
    expect(mocks.send.mock.calls[0][0][0]).toBe(3)
    expect(decodePresence(mocks.send.mock.calls[0][0].subarray(1))?.label).toBe('Alice')
    expect(result.current.remoteSelection).toMatchObject({ noteId: shared.id, start: 6, end: 11, label: 'Bob' })
    expect(persist).not.toHaveBeenCalled()
    expect(JSON.stringify(shared)).toBe(original)
    await act(async () => { result.current.updateSelection(shared.id, null); await vi.advanceTimersByTimeAsync(50) })
    expect(decodePresence(mocks.send.mock.calls.at(-1)![0].subarray(1))?.selection).toBeNull()
    peer.destroy()
  })

  it('does not send new packet types to a peer running the old protocol', async () => {
    const { result, shared, peer, presence } = await setup(false)
    await act(async () => {
      result.current.updateSelection(shared.id, { field: 'content', start: 1, end: 1 })
      await callbacks.onMessage(presence())
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(mocks.send).not.toHaveBeenCalled()
    expect(result.current.remoteSelection).toBeNull()
    peer.destroy()
  })

  it('re-resolves remote positions after local edits, peer updates and a homeserver replica merge', async () => {
    const { result, props, rerender, shared, peer, presence, persist } = await setup()
    await act(async () => { await callbacks.onMessage(presence()); await vi.advanceTimersByTimeAsync(50) })
    let local = shared
    act(() => { local = result.current.edit(shared, { content: `Prefix ${shared.content}` }) })
    expect(result.current.remoteSelection?.start).toBe(13)
    peer.edit({ content: `${peer.note.content}!` })
    await act(async () => { await callbacks.onMessage(new Uint8Array([1, ...peer.getUpdate()])) })
    expect(result.current.remoteSelection?.start).toBe(13)
    expect(persist).toHaveBeenCalledOnce()
    const replica = new SharedNoteDocument(local)
    replica.edit({ content: `Own ${replica.note.content}` })
    rerender({ ...props, notes: [replica.note] })
    expect(result.current.remoteSelection?.start).toBe(17)
    peer.destroy(); replica.destroy()
  })

  it('clears remote cursors and delayed sends when switching notes, disconnecting, hiding or changing accounts', async () => {
    const { result, props, rerender, shared, peer, presence, persist } = await setup()
    await act(async () => { await callbacks.onMessage(presence()); await vi.advanceTimersByTimeAsync(50) })
    rerender({ ...props, activeId: 'another-note' })
    expect(result.current.remoteSelection).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(decodePresence(mocks.send.mock.calls.at(-1)![0].subarray(1))?.selection).toBeNull()
    rerender(props)
    await act(async () => { await callbacks.onMessage(presence()); await vi.advanceTimersByTimeAsync(50) })
    expect(result.current.remoteSelection).not.toBeNull()
    act(() => { callbacks.onStatus({ state: 'disconnected', relayAvailable: false }) })
    expect(result.current.remoteSelection).toBeNull()
    act(() => { callbacks.onStatus({ state: 'connected', relayAvailable: false, presenceSupported: true }) })
    await act(async () => { await callbacks.onMessage(presence()); await vi.advanceTimersByTimeAsync(50) })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current.remoteSelection).toBeNull()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')); result.current.updateSelection(shared.id, { field: 'content', start: 2, end: 2 }) })
    rerender({ ...props, scope: 'bob', enabled: false })
    mocks.send.mockClear()
    await act(async () => { await callbacks.onMessage(presence()); await vi.advanceTimersByTimeAsync(30_000) })
    expect(mocks.send).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(result.current.remoteSelection).toBeNull()
    expect(mocks.dispose).toHaveBeenCalledOnce()
    peer.destroy()
  })
})
