// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCollaboration } from './useCollaboration'
import { initializeNote } from '../lib/crdt'
import { createSharedNote, SharedNoteDocument } from '../lib/shared-note'
import type { CollaborationCallbacks, StoredRoom } from '../lib/collaboration'
import { decodePresence } from '../lib/collaboration/presence'
import type { CrdtNote } from '../lib/crdt'

const mocks = vi.hoisted(() => ({ start: vi.fn(), load: vi.fn(), create: vi.fn(), send: vi.fn(), dispose: vi.fn() }))
vi.mock('../lib/collaboration', () => ({
  startCollaboration: mocks.start, loadRoom: mocks.load, createHostRoom: mocks.create,
  fingerprint: async () => 'OWN FINGERPRINT', invitationUrl: () => 'https://example.com/#collaborate=test',
  parseInvitation: () => null, createGuestRoom: vi.fn(),
}))

let callbacks: CollaborationCallbacks
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('crypto', webcrypto)
  mocks.send.mockReset().mockResolvedValue(undefined)
  mocks.dispose.mockReset(); mocks.load.mockReset().mockResolvedValue(null)
  mocks.start.mockReset().mockImplementation((_room: StoredRoom, next: CollaborationCallbacks) => {
    callbacks = next
    return { send: mocks.send, dispose: mocks.dispose, approve: vi.fn(), reject: vi.fn(), reconnect: vi.fn() }
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function setup(presenceSupported = true, remapNotes = false) {
  const shared = createSharedNote(initializeNote({ id: 'source', title: 'Meeting', content: 'Hello world', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' }))
  const room = { scope: 'alice', role: 'host', descriptor: { id: shared.id, lineage: shared.crdt!.lineage, createdAt: shared.createdAt }, identity: { publicKey: 'key' } } as StoredRoom
  mocks.create.mockResolvedValue(room)
  const persist = vi.fn(async (_note: CrdtNote, _scope: string, _select?: boolean) => {})
  const beforeRemoteChange = vi.fn<(_doc: SharedNoteDocument) => (() => void) | undefined>(() => undefined)
  const props = { scope: 'alice', enabled: true, notes: [shared], activeId: shared.id, displayName: 'Alice', persist, beforeRemoteChange }
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
