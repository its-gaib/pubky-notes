import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGuestRoom, createHostRoom, createIdentity, loadRoom, randomToken } from './credentials'
import { testIdentity } from './identity.test-helpers'
import type { CollaborationCallbacks, CollaborationIdentity, CollaborationOptions, GroupCollaborationStatus, GroupCollaborationTransport, Invitation, StoredRoom } from './types'

interface Endpoint { room: StoredRoom; callbacks: CollaborationCallbacks; options: CollaborationOptions; disposed: boolean; connected: boolean; other?: Endpoint; sends: Uint8Array[] }
const network = vi.hoisted(() => ({ endpoints: new Map<string, Endpoint[]>(), watchers: new Map<string, (key: string) => void>(), errors: [] as unknown[], drops: new Map<string, number>() }))

vi.mock('./ice-cache', () => ({ createIceConfigurationCache: () => ({ get: async () => ({ iceServers: [], expiresAt: Date.now() + 600_000, relayAvailable: true }), dispose() {} }) }))
vi.mock('./discovery', () => ({ startDiscovery(room: StoredRoom, options: { onJoin?(key: string): void }) {
  if (room.role === 'host') {
    network.watchers.set(room.room, options.onJoin!)
    return { dispose() { if (network.watchers.get(room.room) === options.onJoin) network.watchers.delete(room.room) } }
  }
  const announce = () => network.watchers.get(room.room)?.(room.identity.publicKey)
  const interval = setInterval(announce, 5)
  queueMicrotask(announce)
  return { dispose() { clearInterval(interval) } }
} }))
vi.mock('./transport', () => ({ webRtcAvailable: () => true, WEBRTC_UNAVAILABLE_MESSAGE: 'WebRTC unavailable', startCollaboration(room: StoredRoom, callbacks: CollaborationCallbacks, options: CollaborationOptions) {
  const endpoint: Endpoint = { room, callbacks, options, disposed: false, connected: false, sends: [] }
  const list = network.endpoints.get(room.room) ?? []
  list.push(endpoint); network.endpoints.set(room.room, list)
  async function connect() {
    const other = list.find(item => item !== endpoint && !item.disposed)
    if (endpoint.disposed || endpoint.connected || !other || other.connected) return
    endpoint.connected = other.connected = true; endpoint.other = other; other.other = endpoint
    try {
      await Promise.all([options.pair!.authorize(other.options.identity!.owner), other.options.pair!.authorize(options.identity!.owner)])
      if (endpoint.disposed || other.disposed) return
      const firstSession = randomToken(16), secondSession = randomToken(16)
      callbacks.onStatus({ state: 'connected', relayAvailable: true, peerIdentity: other.options.identity!.owner, peerSession: secondSession, presenceSupported: true })
      other.callbacks.onStatus({ state: 'connected', relayAvailable: true, peerIdentity: options.identity!.owner, peerSession: firstSession, presenceSupported: true })
    } catch (error) {
      const issue = (error as { code?: 'room-full' | 'account-already-joined' }).code ?? 'identity-verification-failed'
      for (const peer of [endpoint, other]) {
        if (!peer.disposed) { peer.callbacks.onStatus({ state: 'error', relayAvailable: true, issue }); peer.callbacks.onError(error as Error) }
      }
    }
  }
  queueMicrotask(() => { void connect() })
  return {
    async send(bytes: Uint8Array) {
      if (endpoint.disposed || !endpoint.other || endpoint.other.disposed) return
      endpoint.sends.push(bytes.slice())
      const tag = `${room.identity.publicKey}:${bytes[1]}`, remaining = network.drops.get(tag) ?? 0
      if (remaining > 0) { network.drops.set(tag, remaining - 1); return }
      const target = endpoint.other
      queueMicrotask(() => {
        if (!target.disposed) Promise.resolve(target.callbacks.onMessage(bytes.slice())).catch(error => network.errors.push(error))
      })
    },
    reconnect() { endpoint.connected = false; if (endpoint.other) endpoint.other.connected = false; void connect() },
    dispose() {
      if (endpoint.disposed) return
      endpoint.disposed = true; endpoint.connected = false
      if (endpoint.other && !endpoint.other.disposed) {
        endpoint.other.connected = false
        endpoint.other.callbacks.onStatus({ state: 'disconnected', relayAvailable: true })
      }
    },
  }
} }))

import { pairRoom, startCollaboration } from './group'

const invitation = (room: StoredRoom): Invitation => ({ version: 1, room: room.room, secret: room.secret, hostKey: room.hostKey, descriptor: room.descriptor })
const active: GroupCollaborationTransport[] = []
function launch(room: StoredRoom, identity = testIdentity(), received?: (bytes: Uint8Array) => Promise<void>) {
  const statuses: GroupCollaborationStatus[] = [], errors: Error[] = [], messages: { bytes: Uint8Array; peer: string }[] = []
  const transport = startCollaboration(room, { onStatus: status => statuses.push(status), onError: error => errors.push(error), onMessage: (bytes, peer) => { messages.push({ bytes, peer }); return received?.(bytes) } }, { identity })
  active.push(transport)
  return { room, identity, transport, statuses, errors, messages, status: () => statuses.at(-1) }
}
async function creator() {
  const room = await createHostRoom(`creator:${crypto.randomUUID()}`, { id: crypto.randomUUID(), createdAt: new Date().toISOString(), lineage: `shared:${crypto.randomUUID()}` })
  const running = launch(room)
  await vi.waitFor(() => expect(running.status()?.state).toBe('waiting'))
  return running
}
async function guest(host: StoredRoom, identity?: CollaborationIdentity) {
  return launch(await createGuestRoom(`guest:${crypto.randomUUID()}`, invitation(host)), identity)
}

beforeEach(() => { vi.stubGlobal('location', new URL('https://notes.example')); network.endpoints.clear(); network.watchers.clear(); network.errors.length = 0; network.drops.clear() })
afterEach(() => { active.splice(0).forEach(transport => transport.dispose()); vi.restoreAllMocks() })

describe('authenticated group orchestration', () => {
  it('derives symmetric independent edge inboxes and deterministic offerer roles', async () => {
    const host = await creator(), first = await guest(host.room), second = await guest(host.room)
    const a = await pairRoom(first.room, second.room.identity.publicKey)
    const b = await pairRoom(second.room, first.room.identity.publicKey)
    expect(a.room).toBe(b.room); expect(a.hostKey).toBe(b.hostKey); expect(a.role).not.toBe(b.role)
    expect((await pairRoom(host.room, first.room.identity.publicKey)).hostKey).toBe(host.room.hostKey)
    expect(a.room).not.toBe((await pairRoom(host.room, first.room.identity.publicKey)).room)
    expect(a.room).not.toBe(host.room.room)
  })

  it('admits ten total, forms all45edges, rejects an eleventh, and attributes each delivered sender', async () => {
    const host = await creator()
    const guests = await Promise.all(Array.from({ length: 9 }, () => guest(host.room)))
    const all = [host, ...guests]
    await vi.waitFor(() => all.forEach(peer => {
      expect(peer.status()?.peers, JSON.stringify(all.map(item => ({ peers: item.status()?.peers.length, members: item.status()?.participantCount, errors: item.errors.map(error => error.message) })))).toHaveLength(9)
      expect(peer.status()?.participantCount).toBe(10)
    }), { timeout: 15_000 })
    expect(network.endpoints.size).toBe(45)
    const outsider = await guest(host.room)
    await vi.waitFor(() => expect(outsider.status()?.issue).toBe('room-full'))
    expect(outsider.status()?.peers).toHaveLength(0)
    await guests[0].transport.send(new Uint8Array([7, 8, 9]))
    await vi.waitFor(() => all.filter(peer => peer !== guests[0]).forEach(peer => expect(peer.messages.at(-1)).toEqual({ bytes: new Uint8Array([7, 8, 9]), peer: guests[0].room.identity.publicKey })))
    expect(outsider.messages).toHaveLength(0)
    expect(network.errors).toHaveLength(0)
  }, 20_000)

  it('keeps admitted peers connected and resumes their mesh after creator departure and reload', async () => {
    const host = await creator(), first = await guest(host.room), second = await guest(host.room)
    await vi.waitFor(() => expect(first.status()?.peers).toHaveLength(2))
    host.transport.dispose()
    await vi.waitFor(() => {
      expect(first.status()?.creatorOnline).toBe(false)
      expect(second.status()?.creatorOnline).toBe(false)
      expect(first.status()?.peers).toHaveLength(1)
    })
    await first.transport.send(new Uint8Array([42]))
    await vi.waitFor(() => expect(second.messages.at(-1)?.bytes).toEqual(new Uint8Array([42])))
    first.transport.dispose()
    const resumed = launch((await loadRoom(first.room.scope, first.room.descriptor.id))!, first.identity)
    await vi.waitFor(() => expect(resumed.status()?.peers).toHaveLength(1))
    expect(resumed.status()?.creatorOnline).toBe(false)
    await resumed.transport.send(new Uint8Array([43]))
    await vi.waitFor(() => expect(second.messages.at(-1)?.bytes).toEqual(new Uint8Array([43])))
    expect(network.errors).toHaveLength(0)
  })

  it('requires a direct verified account match even when a browser key is already admitted', async () => {
    const host = await creator(), first = await guest(host.room)
    await vi.waitFor(() => expect(host.status()?.peers).toHaveLength(1))
    first.transport.dispose()
    const impostor = launch((await loadRoom(first.room.scope, first.room.descriptor.id))!, testIdentity())
    await vi.waitFor(() => expect(impostor.status()?.state).toBe('error'))
    expect(impostor.status()?.peers).toHaveLength(0)
    expect(impostor.errors.at(-1)?.message).toContain('not an admitted collaborator')
  })

  it('refuses a forged roster while retaining the previously verified membership', async () => {
    const host = await creator()
    const room = await createGuestRoom(`guest:${crypto.randomUUID()}`, invitation(host.room))
    const identity = testIdentity(), running = launch(room, identity)
    await vi.waitFor(() => expect(running.status()?.peers).toHaveLength(1))
    const child = await pairRoom(room, room.hostKey)
    const endpoint = network.endpoints.get(child.room)!.find(candidate => candidate.room.identity.publicKey === room.identity.publicKey)!
    const roster = JSON.parse(JSON.stringify(room.membership))
    roster.members[0].owner = testIdentity().owner
    const payload = new TextEncoder().encode(JSON.stringify(roster)), message = new Uint8Array(payload.length + 2)
    message.set([0x47, 1]); message.set(payload, 2)
    await endpoint.callbacks.onMessage(message)
    expect(running.errors.at(-1)?.message).toContain('Invalid collaboration membership')
    expect(running.status()?.peers).toHaveLength(0)
    expect(room.membership?.members[0].owner).toBe(host.identity.owner)
    await endpoint.callbacks.onMessage(new Uint8Array([0x47, 2, 99]))
    expect(running.messages.at(-1)?.bytes).toEqual(new Uint8Array([99]))
    expect(running.status()?.peers[0].owner).toBe(host.identity.owner)
  })

  it('does not publish status or create connections after disposal during startup', async () => {
    const host = await creator()
    const room = await createGuestRoom(`guest:${crypto.randomUUID()}`, invitation(host.room))
    const running = launch(room)
    running.transport.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(running.statuses).toHaveLength(0)
    expect([...network.endpoints.values()].flat().some(endpoint => endpoint.room.identity.publicKey === room.identity.publicKey)).toBe(false)
    // An unadmitted arbitrary browser key cannot accidentally become a member.
    expect(host.room.membership?.members.some(member => member.key === (room.identity.publicKey))).toBe(false)
    expect((await createIdentity()).publicKey).not.toBe(room.identity.publicKey)
  })

  it('discards queued messages from an old verified session when the same edge reconnects', async () => {
    const host = await creator()
    const room = await createGuestRoom(`guest:${crypto.randomUUID()}`, invitation(host.room))
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const running = launch(room, testIdentity(), async bytes => { if (bytes[0] === 1) await blocked })
    await vi.waitFor(() => expect(running.status()?.peers).toHaveLength(1))
    const child = await pairRoom(room, room.hostKey)
    const endpoint = network.endpoints.get(child.room)!.find(candidate => candidate.room.identity.publicKey === room.identity.publicKey)!
    const first = endpoint.callbacks.onMessage(new Uint8Array([0x47, 2, 1]))
    await vi.waitFor(() => expect(running.messages).toHaveLength(1))
    const stale = endpoint.callbacks.onMessage(new Uint8Array([0x47, 2, 2]))
    endpoint.callbacks.onStatus({ state: 'disconnected', relayAvailable: true })
    endpoint.callbacks.onStatus({ state: 'connected', relayAvailable: true, peerIdentity: host.identity.owner, peerSession: randomToken(16), presenceSupported: true })
    release()
    await Promise.all([first, stale])
    await vi.waitFor(() => expect(running.status()?.peers).toHaveLength(1))
    expect(running.messages.map(message => message.bytes[0])).toEqual([1])
    await endpoint.callbacks.onMessage(new Uint8Array([0x47, 2, 3]))
    expect(running.messages.map(message => message.bytes[0])).toEqual([1, 3])
  })

  it('retries a lost first roster and a lost receipt without exposing document data before admission', async () => {
    const host = await creator()
    const room = await createGuestRoom(`guest:${crypto.randomUUID()}`, invitation(host.room))
    network.drops.set(`${host.room.identity.publicKey}:1`, 1)
    network.drops.set(`${room.identity.publicKey}:3`, 1)
    const running = launch(room)
    const child = await pairRoom(room, room.hostKey)
    await vi.waitFor(() => expect(network.drops.get(`${host.room.identity.publicKey}:1`)).toBe(0))
    expect(running.status()?.peers).toHaveLength(0)
    expect(host.status()?.peers).toHaveLength(0)
    const endpoint = network.endpoints.get(child.room)!.find(candidate => candidate.room.identity.publicKey === room.identity.publicKey)!
    await endpoint.callbacks.onMessage(new Uint8Array([0x47, 2, 88]))
    expect(running.messages).toHaveLength(0)
    expect(running.errors.at(-1)?.message).toContain('before verified admission')
    await vi.waitFor(() => {
      expect(host.status()?.peers).toHaveLength(1)
      expect(running.status()?.peers).toHaveLength(1)
    }, { timeout: 12_000 })
    expect(network.drops.get(`${room.identity.publicKey}:3`)).toBe(0)
    await host.transport.send(new Uint8Array([89]))
    await vi.waitFor(() => expect(running.messages.at(-1)?.bytes).toEqual(new Uint8Array([89])))
    const sends = network.endpoints.get(child.room)!.flatMap(peer => peer.sends)
    expect(sends.filter(bytes => bytes[1] === 1).length).toBeGreaterThan(2)
    expect(network.errors).toHaveLength(0)
  }, 15_000)

  it('reports the shared TURN configuration while waiting for the first participant', async () => {
    const host = await creator()
    expect(host.status()?.peers).toHaveLength(0)
    expect(host.status()?.relayAvailable).toBe(true)
  })
})
