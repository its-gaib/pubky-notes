import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { admitPeer, createGuestRoom, createHostRoom, createIdentity, decodeBytes, deleteRoom, encodeBytes, fingerprint, invitationUrl, loadRoom, parseInvitation, randomToken } from './credentials'
import { frameMessage, MAX_MESSAGE_BYTES, MessageAssembler } from './framing'
import { openSignal, ReplayGuard, sealSignal } from './signaling'
import { startCollaboration } from './transport'
import type { CollaborationCallbacks, Invitation, StoredRoom } from './types'

const descriptor = () => ({ id: crypto.randomUUID(), createdAt: '2026-10-14T10:00:00.000Z', lineage: `shared:${crypto.randomUUID()}` })
const invitation = (room: StoredRoom): Invitation => ({ version: 1, room: room.room, secret: room.secret, hostKey: room.hostKey, descriptor: room.descriptor })
async function pair() {
  const host = await createHostRoom(`host:${crypto.randomUUID()}`, descriptor())
  return { host, guest: await createGuestRoom(`guest:${crypto.randomUUID()}`, invitation(host)) }
}
const helloFields = (host: StoredRoom) => ({ to: host.identity.publicKey, session: randomToken(16), targetSession: '', kind: 'hello' as const, payload: '' })

afterEach(() => vi.restoreAllMocks())

describe('collaboration credentials and invitation boundaries', () => {
  it('round-trips a fragment-only invitation without signing keys or account identifiers', async () => {
    const { host } = await pair()
    const link = invitationUrl(host, 'https://notes.example/notes?view=1')
    expect(new URL(link).search).toBe('?view=1')
    expect(new URL(link).pathname).toBe('/notes')
    expect(parseInvitation(new URL(link).hash)).toEqual(invitation(host))
    expect(JSON.stringify(parseInvitation(new URL(link).hash))).not.toContain(host.scope)
    expect(host.identity.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('jwk', host.identity.privateKey)).rejects.toThrow()
  })

  it('restores the exact guest key and keeps credentials isolated by account', async () => {
    const { host, guest } = await pair()
    const resumed = await createGuestRoom(guest.scope, invitation(host))
    expect(resumed.identity.publicKey).toBe(guest.identity.publicKey)
    expect(await loadRoom('other-account', guest.descriptor.id)).toBeUndefined()
    await deleteRoom(guest.scope, guest.descriptor.id)
    expect(await loadRoom(guest.scope, guest.descriptor.id)).toBeUndefined()
    expect(await loadRoom(host.scope, host.descriptor.id)).toBeDefined()
  })

  it('does not overwrite another room with the same note id', async () => {
    const { host, guest } = await pair()
    await expect(createGuestRoom(guest.scope, { ...invitation(host), secret: randomToken(32) })).rejects.toThrow('different collaboration')
    expect((await loadRoom(guest.scope, guest.descriptor.id))?.secret).toBe(host.secret)
  })

  it('requires an account and a fresh shared lineage', async () => {
    await expect(createHostRoom('guest', descriptor())).rejects.toThrow('Sign in')
    await expect(createHostRoom('account', { ...descriptor(), lineage: 'new:private-history' })).rejects.toThrow('Invalid shared')
  })

  it('strictly bounds and validates invitation data', async () => {
    const { host } = await pair()
    expect(parseInvitation('#ordinary-route')).toBeNull()
    const invalid = (value: unknown) => `#collaborate=${encodeBytes(new TextEncoder().encode(JSON.stringify(value)))}`
    expect(() => parseInvitation(invalid({ ...invitation(host), secret: randomToken(31) }))).toThrow()
    expect(() => parseInvitation(invalid({ ...invitation(host), unexpected: true }))).toThrow()
    expect(() => parseInvitation(invalid({ ...invitation(host), descriptor: { ...host.descriptor, id: '../private' } }))).toThrow()
    expect(() => parseInvitation(`#collaborate=${'a'.repeat(4097)}`)).toThrow()
    expect(() => decodeBytes('YQ==')).toThrow()
    expect(() => decodeBytes('YR')).toThrow()
    expect(() => decodeBytes('a'.repeat(256), 16)).toThrow()
  })

  it('atomically admits only one guest even when two host tabs approve concurrently', async () => {
    const { host, guest } = await pair()
    const other = await createIdentity()
    const anotherTab = (await loadRoom(host.scope, host.descriptor.id))!
    const results = await Promise.allSettled([admitPeer(host, guest.identity.publicKey), admitPeer(anotherTab, other.publicKey)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((await loadRoom(host.scope, host.descriptor.id))?.approvedPeer).toBe(guest.identity.publicKey)
    await admitPeer(host, guest.identity.publicKey)
    await expect(admitPeer(host, other.publicKey)).rejects.toThrow('already has')
  })

  it('has stable peer fingerprints without pretending they are Pubky identities', async () => {
    const { host, guest } = await pair()
    expect(await fingerprint(host.hostKey)).toMatch(/^([a-f0-9]{4} ){5}[a-f0-9]{4}$/)
    expect(await fingerprint(host.hostKey)).not.toBe(await fingerprint(guest.identity.publicKey))
  })
})

describe('encrypted authenticated signaling', () => {
  it('authenticates a guest hello and refuses replay', async () => {
    const { host, guest } = await pair()
    const encrypted = await sealSignal(guest, helloFields(host))
    const guard = new ReplayGuard()
    expect(await openSignal(encrypted, host, guard)).toMatchObject({ kind: 'hello', from: guest.identity.publicKey, to: host.hostKey })
    expect(await openSignal(encrypted, host, guard)).toBeNull()
    expect(JSON.stringify(encrypted)).not.toContain(guest.identity.publicKey)
  })

  it('rejects altered ciphertext and a wrong room secret', async () => {
    const { host, guest } = await pair()
    const encrypted = await sealSignal(guest, helloFields(host))
    const bytes = decodeBytes(encrypted.ciphertext)
    bytes[20] ^= 1
    expect(await openSignal({ ...encrypted, ciphertext: encodeBytes(bytes) }, host, new ReplayGuard())).toBeNull()
    expect(await openSignal(encrypted, { ...host, secret: randomToken(32) }, new ReplayGuard())).toBeNull()
    expect(await openSignal(encrypted, { ...host, room: randomToken(24) }, new ReplayGuard())).toBeNull()
  })

  it('pins the host identity even against another invitation holder who knows the encryption secret', async () => {
    const { host, guest } = await pair()
    const impostor = { ...host, identity: await createIdentity() }
    const fields = { to: guest.identity.publicKey, session: randomToken(16), targetSession: randomToken(16), kind: 'offer' as const, payload: 'v=0\r\n' }
    expect(await openSignal(await sealSignal(impostor, fields), guest, new ReplayGuard())).toBeNull()
    expect(await openSignal(await sealSignal(host, fields), guest, new ReplayGuard())).toMatchObject({ kind: 'offer', from: host.hostKey })
  })

  it('rejects a forged signature with the correct claimed public key', async () => {
    const { host, guest } = await pair()
    const impostor = { ...host, identity: { publicKey: host.hostKey, privateKey: (await createIdentity()).privateKey } }
    const encrypted = await sealSignal(impostor, { to: guest.identity.publicKey, session: randomToken(16), targetSession: randomToken(16), kind: 'offer', payload: 'v=0' })
    expect(await openSignal(encrypted, guest, new ReplayGuard())).toBeNull()
  })

  it('rejects messages routed to a different identity and stale or future setup messages', async () => {
    const { host, guest } = await pair()
    const fields = helloFields(host)
    const foreign = await sealSignal(guest, { ...fields, to: (await createIdentity()).publicKey })
    expect(await openSignal(foreign, host, new ReplayGuard())).toBeNull()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 61_000)
    const old = await sealSignal(guest, fields)
    clock.mockReturnValue(now + 61_000)
    const future = await sealSignal(guest, fields)
    clock.mockRestore()
    expect(await openSignal(old, host, new ReplayGuard())).toBeNull()
    expect(await openSignal(future, host, new ReplayGuard())).toBeNull()
  })

  it('rejects malformed and oversized encrypted packets without throwing', async () => {
    const { host } = await pair()
    for (const packet of [null, {}, 'text', { version: 1, iv: randomToken(12), ciphertext: 'x'.repeat(100_000) }, { version: 1, iv: randomToken(11), ciphertext: randomToken(20) }]) {
      expect(await openSignal(packet, host, new ReplayGuard())).toBeNull()
    }
  })

  it('bounds the replay cache and expires old entries', () => {
    const replay = new ReplayGuard()
    for (let index = 0; index < 2048; index++) expect(replay.accept(String(index), 100_000, 100_000)).toBe(true)
    expect(replay.accept('overflow', 100_000, 100_000)).toBe(false)
    expect(replay.accept('0', 100_000, 100_000)).toBe(false)
    expect(replay.accept('new', 160_001, 160_001)).toBe(true)
  })
})

describe('bounded reliable data framing', () => {
  it('round-trips a large binary document without JSON or base64 overhead', () => {
    const input = new Uint8Array(350_123).map((_, index) => index % 251)
    const assembler = new MessageAssembler()
    let output: Uint8Array | undefined
    const frames = [...frameMessage(input)]
    expect(frames.length).toBeGreaterThan(20)
    for (const frame of frames) output = assembler.push(frame)
    expect(output).toEqual(input)
    expect(assembler.push([...frameMessage(new Uint8Array([7]))][0])).toEqual(new Uint8Array([7]))
  })

  it('refuses oversized, empty, reordered, duplicate, malformed, and incomplete stale messages', () => {
    expect(() => [...frameMessage(new Uint8Array(MAX_MESSAGE_BYTES + 1))]).toThrow()
    expect(() => [...frameMessage(new Uint8Array())]).toThrow()
    const frames = [...frameMessage(new Uint8Array(40_000))]
    expect(() => new MessageAssembler().push(frames[1])).toThrow()
    const duplicate = new MessageAssembler()
    duplicate.push(frames[0])
    expect(() => duplicate.push(frames[0])).toThrow()
    const stale = new MessageAssembler()
    stale.push(frames[0], 0)
    expect(() => stale.push(frames[1], 30_001)).toThrow()
    const oversized = frames[0].slice(0)
    new DataView(oversized).setUint32(4, MAX_MESSAGE_BYTES + 1)
    expect(() => new MessageAssembler().push(oversized)).toThrow()
    expect(() => new MessageAssembler().push('not binary')).toThrow()
    expect(() => new MessageAssembler().push(new ArrayBuffer(12))).toThrow()
  })
})

class FakeSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  sent: string[] = []
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  constructor(readonly url: string) { FakeSocket.instances.push(this) }
  open() { this.readyState = 1; this.onopen?.() }
  send(message: string) { this.sent.push(message) }
  receive(data: unknown, topic: string) { this.onmessage?.({ data: JSON.stringify({ type: 'publish', topic, data }) }) }
  close() { this.readyState = 3; this.onclose?.() }
}

class FakeChannel extends EventTarget {
  label = 'pubky-notes-v1'
  ordered = true
  maxRetransmits = null
  maxPacketLifeTime = null
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  binaryType = 'arraybuffer'
  readyState = 'connecting'
  onopen?: () => void
  onclose?: () => void
  onmessage?: (event: { data: unknown }) => void
  sent: ArrayBuffer[] = []
  open() { this.readyState = 'open'; this.onopen?.() }
  send(frame: ArrayBuffer) { this.sent.push(frame) }
  close() { this.readyState = 'closed'; this.onclose?.(); this.dispatchEvent(new Event('close')) }
}

class FakePeer {
  static instances: FakePeer[] = []
  connectionState = 'new'
  signalingState = 'stable'
  localDescription?: RTCSessionDescriptionInit
  remoteDescription?: RTCSessionDescriptionInit
  channel?: FakeChannel
  onicecandidate?: (event: RTCPeerConnectionIceEvent) => void
  ondatachannel?: (event: { channel: FakeChannel }) => void
  onconnectionstatechange?: () => void
  constructor() { FakePeer.instances.push(this) }
  createDataChannel() { this.channel = new FakeChannel(); return this.channel }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' } }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' } }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; this.signalingState = 'have-local-offer' }
  async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = description }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; this.onconnectionstatechange?.() }
}

describe('transport admission and lifetime', () => {
  const active: ReturnType<typeof startCollaboration>[] = []
  afterEach(() => {
    active.splice(0).forEach(transport => transport.dispose())
    vi.unstubAllGlobals()
  })

  function start(room: StoredRoom) {
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    FakeSocket.instances = []
    FakePeer.instances = []
    const callbacks: CollaborationCallbacks = { onStatus: vi.fn(), onRequest: vi.fn(), onMessage: vi.fn(), onError: vi.fn() }
    const transport = startCollaboration(room, callbacks, { signalingUrl: 'ws://127.0.0.1:4444', iceEndpoint: null, rtcConfiguration: { iceServers: [] } })
    active.push(transport)
    return { transport, callbacks }
  }

  async function socket() {
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    const ws = FakeSocket.instances[0]
    ws.open()
    return ws
  }

  it('creates no peer or data channel before explicit admission, then persists the approved key', async () => {
    const { host, guest } = await pair()
    const { transport, callbacks } = start(host)
    const ws = await socket()
    ws.receive(await sealSignal(guest, helloFields(host)), host.room)
    await vi.waitFor(() => expect(callbacks.onRequest).toHaveBeenCalledOnce())
    expect(FakePeer.instances).toHaveLength(0)
    await expect(transport.send(new Uint8Array([1]))).rejects.toThrow('not connected')
    expect(ws.sent.map(packet => JSON.parse(packet)).filter(packet => packet.type === 'publish')).toHaveLength(0)
    await transport.approve(guest.identity.publicKey)
    expect((await loadRoom(host.scope, host.descriptor.id))?.approvedPeer).toBe(guest.identity.publicKey)
    expect(FakePeer.instances).toHaveLength(1)
    FakePeer.instances[0].channel!.open()
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connected', relayAvailable: false }))
    await transport.send(new Uint8Array([1, 2, 3]))
    expect(FakePeer.instances[0].channel!.sent).toHaveLength(1)
  })

  it('rejects another link holder once the one collaborator has been admitted', async () => {
    const { host, guest } = await pair()
    await admitPeer(host, guest.identity.publicKey)
    const outsider = await createGuestRoom(`outsider:${crypto.randomUUID()}`, invitation(host))
    const { callbacks } = start(host)
    const ws = await socket()
    ws.receive(await sealSignal(outsider, helloFields(host)), host.room)
    await vi.waitFor(() => expect(ws.sent.some(packet => JSON.parse(packet).type === 'publish')).toBe(true))
    expect(callbacks.onRequest).not.toHaveBeenCalled()
    expect(FakePeer.instances).toHaveLength(0)
    const reply = JSON.parse(ws.sent.find(packet => JSON.parse(packet).type === 'publish')!).data
    expect(await openSignal(reply, outsider, new ReplayGuard())).toMatchObject({ kind: 'reject' })
  })

  it('automatically reconnects the durable admitted identity without another approval', async () => {
    const { host, guest } = await pair()
    await admitPeer(host, guest.identity.publicKey)
    const { callbacks } = start((await loadRoom(host.scope, host.descriptor.id))!)
    const ws = await socket()
    ws.receive(await sealSignal(guest, helloFields(host)), host.room)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(1))
    expect(callbacks.onRequest).not.toHaveBeenCalled()
  })

  it('serializes complete received messages and stops old-account callbacks after disposal', async () => {
    const { host, guest } = await pair()
    await admitPeer(host, guest.identity.publicKey)
    const { transport, callbacks } = start(host)
    const ws = await socket()
    ws.receive(await sealSignal(guest, helloFields(host)), host.room)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(1))
    const channel = FakePeer.instances[0].channel!
    channel.open()
    channel.onmessage!({ data: [...frameMessage(new Uint8Array([5, 6]))][0] })
    await vi.waitFor(() => expect(callbacks.onMessage).toHaveBeenCalledWith(new Uint8Array([5, 6])))
    transport.dispose()
    channel.onmessage!({ data: [...frameMessage(new Uint8Array([9]))][0] })
    await Promise.resolve()
    expect(callbacks.onMessage).toHaveBeenCalledOnce()
    await expect(transport.send(new Uint8Array([7]))).rejects.toThrow('not connected')
    expect(ws.readyState).toBe(FakeSocket.CLOSED)
  })

  it('does not create a connection after an asynchronous invitation arrives for a disposed scope', async () => {
    const { host, guest } = await pair()
    const { transport, callbacks } = start(host)
    const ws = await socket()
    ws.receive(await sealSignal(guest, helloFields(host)), host.room)
    transport.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(callbacks.onRequest).not.toHaveBeenCalled()
    expect(FakePeer.instances).toHaveLength(0)
  })

  it('reports an incoming already-open channel exactly once even if open/connection events follow', async () => {
    const { host, guest } = await pair()
    const { callbacks } = start(guest)
    const ws = await socket()
    await vi.waitFor(() => expect(ws.sent.some(packet => JSON.parse(packet).type === 'publish')).toBe(true))
    const hello = await openSignal(JSON.parse(ws.sent.find(packet => JSON.parse(packet).type === 'publish')!).data, host, new ReplayGuard())
    ws.receive(await sealSignal(host, { kind: 'offer', to: guest.identity.publicKey, session: randomToken(16), targetSession: hello!.session, payload: 'v=0\r\n' }), host.room)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(1))
    const connection = FakePeer.instances[0]
    const channel = new FakeChannel()
    channel.readyState = 'open'
    connection.ondatachannel!({ channel })
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connected' }))
    channel.onopen!()
    connection.connectionState = 'connected'
    connection.onconnectionstatechange!()
    expect(vi.mocked(callbacks.onStatus).mock.calls.filter(([status]) => status.state === 'connected')).toHaveLength(1)
  })

  it('makes the connection usable before delivering a first message that precedes its open event', async () => {
    const { host, guest } = await pair()
    await admitPeer(host, guest.identity.publicKey)
    const { callbacks } = start(host)
    const ws = await socket()
    ws.receive(await sealSignal(guest, helloFields(host)), host.room)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(1))
    const channel = FakePeer.instances[0].channel!
    channel.readyState = 'open'
    channel.onmessage!({ data: [...frameMessage(new Uint8Array([0]))][0] })
    await vi.waitFor(() => expect(callbacks.onMessage).toHaveBeenCalledOnce())
    const statuses = vi.mocked(callbacks.onStatus)
    const connectedCall = statuses.mock.calls.findIndex(([status]) => status.state === 'connected')
    expect(connectedCall).toBeGreaterThanOrEqual(0)
    expect(statuses.mock.invocationCallOrder[connectedCall]).toBeLessThan(vi.mocked(callbacks.onMessage).mock.invocationCallOrder[0])
  })
})
