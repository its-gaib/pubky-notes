import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { initializeNote } from '../crdt'
import { createSharedNote, joinSharedNote, SharedNoteDocument } from '../shared-note'
import { advertisePresence, decodePresence, MAX_PRESENCE_BYTES, presenceLabel, SelectionPresence, supportsPresence } from './presence'

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
function pair() {
  const source = initializeNote({ id: 'original', title: 'Shared', content: 'First line\nLast line', createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z' })
  const alice = new SharedNoteDocument(createSharedNote(source))
  const bob = new SharedNoteDocument(joinSharedNote(alice.descriptor, alice.getUpdate()))
  return { alice, bob }
}
const disposables: (() => void)[] = []
afterEach(() => { disposables.splice(0).forEach(dispose => dispose()); vi.useRealTimers() })
function setup() {
  vi.useFakeTimers()
  const { alice, bob } = pair()
  const send = vi.fn(async (_payload: Uint8Array) => {}), publish = vi.fn()
  const presence = new SelectionPresence({ document: () => alice, send, publish, label: () => 'Alice', fingerprint: () => 'ABC DEF' })
  presence.setConnected(true)
  disposables.push(() => { presence.dispose(); alice.destroy(); bob.destroy() })
  const incoming = (start = 6, end = start) => bytes({ selection: { ...bob.captureSelection('content', start, end), direction: 'backward' }, label: 'Bob' })
  return { alice, bob, send, publish, presence, incoming }
}

describe('ephemeral collaboration presence', () => {
  it('advertises a strictly matched capability while accepting old peers without it', () => {
    expect(supportsPresence(advertisePresence('v=0\r\n'))).toBe(true)
    expect(supportsPresence('v=0\r\n')).toBe(false)
    expect(supportsPresence('a=x-pubky-notes-presence:10\r\n')).toBe(false)
    expect(supportsPresence('x=a=x-pubky-notes-presence:1\r\n')).toBe(false)
  })

  it('resolves a peer range through concurrent insertions, deletions and own-replica merges without changing the document', async () => {
    const { alice, bob, presence, publish, incoming } = setup()
    const original = JSON.stringify(alice.note)
    presence.receive(incoming(6, 10))
    await vi.advanceTimersByTimeAsync(50)
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ start: 6, end: 10, label: 'Bob', direction: 'backward' }))
    expect(JSON.stringify(alice.note)).toBe(original)
    alice.edit({ content: `Prefix ${alice.note.content}` })
    presence.refresh()
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ start: 13, end: 17 }))
    bob.edit({ content: 'First \nLast line' })
    alice.applyPeerUpdate(bob.getUpdate())
    presence.refresh()
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ start: 13, end: 13 }))
    const ownReplica = new SharedNoteDocument(alice.note)
    ownReplica.edit({ content: `Own ${ownReplica.note.content}` })
    alice.mergeLocal(ownReplica.note)
    presence.refresh()
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ start: 17, end: 17 }))
    ownReplica.destroy()
  })

  it('coalesces hundreds of sends and receives to their latest positions at 20 updates per second', async () => {
    const { presence, send, publish, incoming } = setup()
    for (let i = 0; i < 500; i++) {
      presence.update({ field: 'content', start: i % 10, end: i % 10 })
      presence.receive(incoming(i % 10))
    }
    expect(send).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    expect(send).toHaveBeenCalledOnce(); expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ start: 9 }))
    expect(decodePresence(send.mock.calls[0][0])?.selection).toBeTruthy()
    presence.update(null); presence.receive(bytes({ selection: null, label: '' }))
    await vi.advanceTimersByTimeAsync(50)
    expect(decodePresence(send.mock.calls[1][0])?.selection).toBeNull()
    expect(publish).toHaveBeenLastCalledWith(null)
  })

  it('keeps one outbound update while the transport is blocked', async () => {
    const { presence, send } = setup()
    let release!: () => void
    send.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    presence.update({ field: 'content', start: 1, end: 1 })
    await vi.advanceTimersByTimeAsync(50)
    for (let i = 0; i < 100; i++) presence.update({ field: 'content', start: 6, end: 7 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledOnce()
    release(); await vi.advanceTimersByTimeAsync(50)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('expires remote presence, heartbeats a stationary caret, and clears on hide, disconnect and disposal', async () => {
    const { presence, send, publish, incoming } = setup()
    presence.update({ field: 'content', start: 1, end: 1 }); presence.receive(incoming())
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(5000)
    expect(send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(publish).toHaveBeenLastCalledWith(null)
    presence.receive(incoming()); await vi.advanceTimersByTimeAsync(50)
    presence.setActive(false)
    expect(publish).toHaveBeenLastCalledWith(null)
    await vi.advanceTimersByTimeAsync(50)
    expect(decodePresence(send.mock.calls.at(-1)![0])?.selection).toBeNull()
    presence.setActive(true); presence.receive(incoming()); await vi.advanceTimersByTimeAsync(50)
    presence.setConnected(false)
    expect(publish).toHaveBeenLastCalledWith(null)
    send.mockClear(); presence.update({ field: 'content', start: 1, end: 1 }); presence.receive(incoming())
    presence.dispose(); await vi.advanceTimersByTimeAsync(30_000)
    expect(send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects oversized, invalid and cross-root positions before they can mutate note data', async () => {
    const { alice, bob, presence, publish, incoming } = setup()
    const original = JSON.stringify(alice.note), selection = bob.captureSelection('content', 1)
    const malformed = [new Uint8Array(MAX_PRESENCE_BYTES + 1), new Uint8Array([255]), bytes({ selection: { ...selection, field: 'arbitrary', direction: 'none' }, label: '' }),
      bytes({ selection: { ...selection, start: { type: null, tname: 'arbitrary', item: null, assoc: 0 }, direction: 'none' }, label: '' }),
      bytes({ selection: { ...selection, start: { type: null, tname: 'content', item: { client: -1, clock: 0 }, assoc: 0 }, direction: 'none' }, label: '' }),
      bytes({ selection: { ...selection, start: { type: null, tname: 'content', item: null, assoc: 9000 }, direction: 'none' }, label: '' }),
      bytes({ selection: { ...selection, direction: 'none' }, label: 'x'.repeat(257) })]
    for (const payload of malformed) {
      expect(decodePresence(payload)).toBeUndefined()
      presence.receive(payload); await vi.advanceTimersByTimeAsync(50)
    }
    expect(publish).not.toHaveBeenCalled()
    const titlePosition = bob.captureSelection('title', 1).start
    // Even a structurally valid root label cannot make an item from the title resolve as content.
    const forged = new Y.RelativePosition(null, 'content', titlePosition.item, 0)
    expect(alice.resolveSelection({ field: 'content', start: forged, end: forged })).toBeNull()
    const unknown = new Y.RelativePosition(null, 'untrusted-root', null, 0)
    expect(alice.resolveSelection({ field: 'content', start: unknown, end: unknown })).toBeNull()
    expect(JSON.stringify(alice.note)).toBe(original)
    presence.receive(incoming()); await vi.advanceTimersByTimeAsync(50)
    expect(publish).toHaveBeenCalledOnce()
  })

  it('bounds profile labels and uses a stable fingerprint fallback and color', async () => {
    const { presence, publish, bob } = setup()
    expect(presenceLabel('  A\nB\u202e C  ')).toBe('AB C')
    expect(Array.from(presenceLabel('😀'.repeat(100)))).toHaveLength(64)
    presence.receive(bytes({ selection: { ...bob.captureSelection('content', 1), direction: 'none' }, label: '' }))
    await vi.advanceTimersByTimeAsync(50)
    const first = publish.mock.lastCall![0]
    expect(first.label).toBe('Collaborator ABC DEF')
    presence.refresh()
    expect(publish.mock.lastCall![0].color).toBe(first.color)
  })
})
