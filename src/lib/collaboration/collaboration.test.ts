import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { admitPeer, createGuestRoom, createHostRoom, createIdentity, decodeBytes, deleteRoom, encodeBytes, fingerprint, invitationUrl, loadRoom, parseInvitation, pinHostIdentity, randomToken } from './credentials'
import { frameMessage, MAX_MESSAGE_BYTES, MessageAssembler } from './framing'
import { openSignal, ReplayGuard, sealSignal } from './signaling'
import { startCollaboration, WEBRTC_UNAVAILABLE_MESSAGE } from './transport'
import { advertisePresence, supportsPresence } from './presence'
import type { CollaborationCallbacks, CollaborationIdentity, Invitation, StoredRoom } from './types'
import { createIdentityProof, IDENTITY_FAILED_MESSAGE, IDENTITY_UNAVAILABLE_MESSAGE, verifyIdentityProof } from './identity'
import { testIdentity } from './identity.test-helpers'
import { HttpRelaySocket } from './http-relay'

const identities = new Map<string, CollaborationIdentity>()
function proofIdentity(room: StoredRoom): CollaborationIdentity {
  let identity = identities.get(room.identity.publicKey)
  if (!identity) { identity = testIdentity(); identities.set(room.identity.publicKey, identity) }
  return identity
}

const descriptor = () => ({ id: crypto.randomUUID(), createdAt: '2026-10-14T10:00:00.000Z', lineage: `shared:${crypto.randomUUID()}` })
const invitation = (room: StoredRoom): Invitation => ({ version: 1, room: room.room, secret: room.secret, hostKey: room.hostKey, descriptor: room.descriptor })
async function pair() {
  const host = await createHostRoom(`host:${crypto.randomUUID()}`, descriptor())
  return { host, guest: await createGuestRoom(`guest:${crypto.randomUUID()}`, invitation(host)) }
}
const helloFields = (host: StoredRoom) => ({ to: host.identity.publicKey, session: randomToken(16), targetSession: '', kind: 'hello' as const, payload: JSON.stringify({ challenge: randomToken(24) }) })

afterEach(() => vi.restoreAllMocks())
beforeEach(() => vi.stubGlobal('location', new URL('https://notes.example')))

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

  it('atomically admits only one guest even when two host tabs admit concurrently', async () => {
    const { host, guest } = await pair()
    const other = await createIdentity()
    const anotherTab = (await loadRoom(host.scope, host.descriptor.id))!
    const results = await Promise.allSettled([admitPeer(host, guest.identity.publicKey, proofIdentity(guest).owner), admitPeer(anotherTab, other.publicKey, testIdentity().owner)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((await loadRoom(host.scope, host.descriptor.id))?.approvedPeer).toBe(guest.identity.publicKey)
    await admitPeer(host, guest.identity.publicKey, proofIdentity(guest).owner)
    await expect(admitPeer(host, other.publicKey, testIdentity().owner)).rejects.toThrow('already has')
  })

  it('has stable peer fingerprints without pretending they are Pubky identities', async () => {
    const { host, guest } = await pair()
    expect(await fingerprint(host.hostKey)).toMatch(/^([a-f0-9]{4} ){5}[a-f0-9]{4}$/)
    expect(await fingerprint(host.hostKey)).not.toBe(await fingerprint(guest.identity.publicKey))
  })

  it('pins account identities as well as browser keys across reloads and concurrent tabs', async () => {
    const { host, guest } = await pair()
    const staleGuest = (await loadRoom(guest.scope, guest.descriptor.id))!
    await pinHostIdentity(guest, proofIdentity(host).owner)
    await expect(pinHostIdentity(staleGuest, testIdentity().owner)).rejects.toThrow('identity changed')
    expect((await loadRoom(guest.scope, guest.descriptor.id))?.hostIdentity).toBe(proofIdentity(host).owner)
    await admitPeer(host, guest.identity.publicKey, proofIdentity(guest).owner)
    await expect(admitPeer(host, guest.identity.publicKey, testIdentity().owner)).rejects.toThrow('already has')
    expect((await loadRoom(host.scope, host.descriptor.id))?.approvedPeerIdentity).toBe(proofIdentity(guest).owner)
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
  createdAt = Date.now()
  connectionState = 'new'
  signalingState = 'stable'
  localDescription?: RTCSessionDescriptionInit
  remoteDescription?: RTCSessionDescriptionInit
  channel?: FakeChannel
  onicecandidate?: (event: RTCPeerConnectionIceEvent) => void
  ondatachannel?: (event: { channel: FakeChannel }) => void
  onconnectionstatechange?: () => void
  constructor(readonly configuration: RTCConfiguration) { FakePeer.instances.push(this) }
  createDataChannel() { this.channel = new FakeChannel(); return this.channel }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' } }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' } }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; this.signalingState = 'have-local-offer' }
  async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = description }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; this.onconnectionstatechange?.() }
}

type TestSocket = Pick<FakeSocket, 'sent' | 'receive'>

describe('transport admission and lifetime', () => {
  const active: ReturnType<typeof startCollaboration>[] = []
  afterEach(() => {
    active.splice(0).forEach(transport => transport.dispose())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function start(room: StoredRoom, iceServers: RTCIceServer[] | null = []) {
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    FakeSocket.instances = []
    FakePeer.instances = []
    const callbacks: CollaborationCallbacks = { onStatus: vi.fn(), onMessage: vi.fn(), onError: vi.fn() }
    const transport = startCollaboration(room, callbacks, { identity: proofIdentity(room), signalingUrl: 'ws://127.0.0.1:4444', ...(iceServers === null ? {} : { iceEndpoint: null, rtcConfiguration: { iceServers } }) })
    active.push(transport)
    return { transport, callbacks }
  }

  async function socket() {
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    const ws = FakeSocket.instances[0]
    ws.open()
    return ws
  }

  async function published(ws: TestSocket, recipient: StoredRoom) {
    const values = await Promise.all(ws.sent.map(packet => JSON.parse(packet)).filter(packet => packet.type === 'publish')
      .map(packet => openSignal(packet.data, recipient, new ReplayGuard())))
    return values.filter(value => value !== null)
  }

  async function authenticateGuest(ws: TestSocket, host: StoredRoom, guest: StoredRoom, hello = helloFields(host), identity = proofIdentity(guest)) {
    ws.receive(await sealSignal(guest, hello), host.room)
    let challenge: Awaited<ReturnType<typeof openSignal>>
    await vi.waitFor(async () => {
      challenge = (await published(ws, guest)).findLast(signal => signal.kind === 'challenge' && signal.targetSession === hello.session) ?? null
      expect(challenge).toBeTruthy()
    })
    const payload = JSON.parse(challenge!.payload)
    verifyIdentityProof(payload.proof, { room: host.room, descriptor: host.descriptor, role: 'host', publicKey: host.hostKey,
      peerKey: guest.identity.publicKey, session: challenge!.session, peerSession: hello.session, challenge: JSON.parse(hello.payload).challenge }, proofIdentity(host).owner)
    const { proof } = await createIdentityProof(identity, { room: host.room, descriptor: host.descriptor, role: 'guest',
      publicKey: guest.identity.publicKey, peerKey: host.hostKey, session: hello.session, peerSession: challenge!.session, challenge: payload.challenge })
    ws.receive(await sealSignal(guest, { kind: 'identity', to: host.hostKey, session: hello.session,
      targetSession: challenge!.session, payload: JSON.stringify({ proof }) }), host.room)
    return hello
  }

  async function authenticateHost(ws: FakeSocket, host: StoredRoom, guest: StoredRoom) {
    let hello: Awaited<ReturnType<typeof openSignal>>
    await vi.waitFor(async () => { hello = (await published(ws, host)).find(signal => signal.kind === 'hello') ?? null; expect(hello).toBeTruthy() })
    const session = randomToken(16), challenge = randomToken(24)
    const { proof } = await createIdentityProof(proofIdentity(host), { room: host.room, descriptor: host.descriptor, role: 'host',
      publicKey: host.hostKey, peerKey: guest.identity.publicKey, session, peerSession: hello!.session, challenge: JSON.parse(hello!.payload).challenge })
    ws.receive(await sealSignal(host, { kind: 'challenge', to: guest.identity.publicKey, session,
      targetSession: hello!.session, payload: JSON.stringify({ challenge, proof }) }), host.room)
    await vi.waitFor(async () => { expect((await published(ws, host)).some(signal => signal.kind === 'identity')).toBe(true) })
    return { session, hello: hello! }
  }

  async function answerOffer(ws: FakeSocket, host: StoredRoom, guest: StoredRoom) {
    const offers = ws.sent.map(packet => JSON.parse(packet)).filter(packet => packet.type === 'publish')
    const offer = await openSignal(offers.at(-1)!.data, guest, new ReplayGuard())
    expect(offer?.kind).toBe('offer')
    ws.receive(await sealSignal(guest, { kind: 'answer', to: host.identity.publicKey, session: offer!.targetSession,
      targetSession: offer!.session, payload: 'v=0\r\n' }), host.room)
    await vi.waitFor(() => expect(FakePeer.instances.at(-1)?.remoteDescription?.type).toBe('answer'))
  }

  it.each(['reconnect', 'dispose'] as const)('processes the answer while HTTP ICE delivery waits, and cancels stale delivery on %s', async cancel => {
    const { host, guest } = await pair()
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    FakePeer.instances = []
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
    })))
    let http!: HttpRelaySocket, releaseOffer!: () => void, rejectIce!: (error: Error) => void
    const offerAck = new Promise<void>(resolve => { releaseOffer = resolve })
    const iceAck = new Promise<void>((_resolve, reject) => { rejectIce = reject })
    const sent: string[] = []
    vi.spyOn(HttpRelaySocket.prototype, 'send').mockImplementation(function (this: HttpRelaySocket) { http = this })
    vi.spyOn(HttpRelaySocket.prototype, 'publish').mockImplementation(async message => {
      sent.push(message)
      const signal = await openSignal(JSON.parse(message).data, guest, new ReplayGuard())
      if (signal?.kind === 'offer') await offerAck
      if (signal?.kind === 'ice') await iceAck
    })
    const setLocalDescription = FakePeer.prototype.setLocalDescription
    vi.spyOn(FakePeer.prototype, 'setLocalDescription').mockImplementation(async function (this: FakePeer, description) {
      await setLocalDescription.call(this, description)
      for (let index = 0; index < 2; index++) this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: `candidate:${index}`, sdpMid: '0' }) } } as RTCPeerConnectionIceEvent)
    })
    const addIceCandidate = vi.spyOn(FakePeer.prototype, 'addIceCandidate')
    const callbacks: CollaborationCallbacks = { onStatus: vi.fn(), onMessage: vi.fn(), onError: vi.fn() }
    const transport = startCollaboration(host, callbacks, { identity: proofIdentity(host), signalingUrl: 'https://relay.example/inbox/', iceEndpoint: null, rtcConfiguration: { iceServers: [] } })
    active.push(transport)
    await vi.waitFor(() => expect(http).toBeDefined())
    const ws: TestSocket = { sent, receive: (data, topic) => http.onmessage?.({ data: JSON.stringify({ type: 'publish', topic, data }) } as MessageEvent) }
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(async () => expect((await published(ws, guest)).some(signal => signal.kind === 'offer')).toBe(true))
    expect((await published(ws, guest)).filter(signal => signal.kind === 'ice')).toHaveLength(0)
    releaseOffer()
    await vi.waitFor(async () => expect((await published(ws, guest)).filter(signal => signal.kind === 'ice')).toHaveLength(1))
    const offer = (await published(ws, guest)).find(signal => signal.kind === 'offer')!
    ws.receive(await sealSignal(guest, { kind: 'answer', to: host.hostKey, session: offer.targetSession, targetSession: offer.session, payload: 'v=0\r\n' }), host.room)
    const incoming = { candidate: 'candidate:remote', sdpMid: '0' }
    ws.receive(await sealSignal(guest, { kind: 'ice', to: host.hostKey, session: offer.targetSession, targetSession: offer.session, payload: JSON.stringify(incoming) }), host.room)
    await vi.waitFor(() => expect(FakePeer.instances[0].remoteDescription?.type).toBe('answer'))
    await vi.waitFor(() => expect(addIceCandidate).toHaveBeenCalledWith(incoming))
    transport[cancel]()
    const statuses = vi.mocked(callbacks.onStatus).mock.calls.length
    rejectIce(new Error('Obsolete ICE delivery failed'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await published(ws, guest)).filter(signal => signal.kind === 'ice')).toHaveLength(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onStatus).toHaveBeenCalledTimes(statuses)
  })

  function relayResponse(credential: string, expiresAt = Date.now() + 600_000) {
    return new Response(JSON.stringify({ iceServers: [{ urls: 'turn:relay.example:3478', username: 'test', credential }], relayAvailable: true, expiresAt }))
  }

  async function startRelayedHost(fetch: typeof globalThis.fetch) {
    const { host, guest } = await pair()
    await admitPeer(host, guest.identity.publicKey, proofIdentity(guest).owner)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.stubGlobal('fetch', fetch)
    const { transport, callbacks } = start(host, null)
    const ws = await socket()
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(1))
    const first = FakePeer.instances[0]
    first.channel!.open()
    return { host, guest, ws, first, transport, callbacks }
  }

  it('replaces a connected TURN allocation before expiry through a fresh pinned identity handshake', async () => {
    const expirations: number[] = []
    const fetch = vi.fn(async () => { expirations.push(Date.now() + 600_000); return relayResponse(`credential-${expirations.length}`, expirations.at(-1)) })
    const { host, guest, ws, first, transport, callbacks } = await startRelayedHost(fetch)
    await vi.advanceTimersByTimeAsync(expirations[0] - 120_000 - Date.now() - 1)
    expect(fetch).toHaveBeenCalledOnce()
    expect(first.channel!.readyState).toBe('open')
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(first.connectionState).toBe('closed')
    expect(first.channel!.readyState).toBe('closed')
    await expect(transport.send(new Uint8Array([1]))).rejects.toThrow('not connected')
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(2))
    const second = FakePeer.instances[1]
    expect(second.configuration.iceServers![0].credential).toBe('credential-2')
    second.channel!.open()
    await transport.send(new Uint8Array([2]))
    expect(second.channel!.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(expirations[1] - 120_000 - Date.now())
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(second.connectionState).toBe('closed')
  })

  it.each(['http', 'fallback'] as const)('retains working relay credentials during %s failures, bounds retries, and reconnects at expiry', async failure => {
    let expiresAt = 0
    const fetch = vi.fn(async () => {
      if (!expiresAt) { expiresAt = Date.now() + 600_000; return relayResponse('working', expiresAt) }
      return failure === 'http' ? new Response('', { status: 503 }) : new Response(JSON.stringify({ iceServers: [], relayAvailable: false }))
    })
    const { first, transport, callbacks } = await startRelayedHost(fetch)
    await vi.advanceTimersByTimeAsync(expiresAt - 120_000 - Date.now())
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(first.channel!.readyState).toBe('open')
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connected', relayAvailable: true }))
    await transport.send(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(95_000)
    expect(fetch).toHaveBeenCalledTimes(7)
    await vi.advanceTimersByTimeAsync(expiresAt - Date.now() - 1)
    expect(fetch).toHaveBeenCalledTimes(7)
    expect(first.channel!.readyState).toBe('open')
    expect(first.configuration.iceServers![0].credential).toBe('working')
    await vi.advanceTimersByTimeAsync(1)
    expect(first.connectionState).toBe('closed')
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'disconnected' }))
  })

  it('recovers a transient renewal failure while retaining the connection until new credentials arrive', async () => {
    let expiresAt = 0
    const fetch = vi.fn(async () => {
      if (!expiresAt) { expiresAt = Date.now() + 600_000; return relayResponse('first', expiresAt) }
      if (fetch.mock.calls.length === 2) throw new Error('Temporary network failure')
      return relayResponse('renewed')
    })
    const { first, callbacks } = await startRelayedHost(fetch)
    await vi.advanceTimersByTimeAsync(expiresAt - 120_000 - Date.now())
    expect(first.channel!.readyState).toBe('open')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(first.connectionState).toBe('closed')
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'disconnected', relayAvailable: true }))
  })

  it('does not repeatedly reconnect for a cached response with the original expiry', async () => {
    let expiresAt = 0
    const fetch = vi.fn(async () => { expiresAt ||= Date.now() + 600_000; return relayResponse('unchanged', expiresAt) })
    const { first, callbacks } = await startRelayedHost(fetch)
    await vi.advanceTimersByTimeAsync(expiresAt - 120_000 - Date.now() + 95_000)
    expect(fetch).toHaveBeenCalledTimes(7)
    expect(first.channel!.readyState).toBe('open')
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connected', relayAvailable: true }))
  })

  it.each(['success', 'failure'] as const)('ignores a stale renewal %s after manual reconnect without altering the replacement peer', async result => {
    let expiresAt = 0, resolveRenewal!: (response: Response) => void, renewalSignal: AbortSignal | undefined
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!expiresAt) { expiresAt = Date.now() + 600_000; return relayResponse('original', expiresAt) }
      renewalSignal = init?.signal as AbortSignal
      return new Promise<Response>(resolve => { resolveRenewal = resolve })
    })
    const { host, guest, ws, first, transport, callbacks } = await startRelayedHost(fetch)
    await vi.advanceTimersByTimeAsync(expiresAt - 120_000 - Date.now())
    expect(fetch).toHaveBeenCalledTimes(2)
    // Repeated data callbacks must not arm duplicate renewal jobs while fetch waits.
    first.channel!.onmessage!({ data: [...frameMessage(new Uint8Array([1]))][0] })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    transport.reconnect()
    expect(renewalSignal!.aborted).toBe(true)
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(2))
    const second = FakePeer.instances[1]
    const statusCount = vi.mocked(callbacks.onStatus).mock.calls.length
    resolveRenewal(result === 'success' ? relayResponse('obsolete') : new Response('', { status: 503 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(second.connectionState).not.toBe('closed')
    expect(callbacks.onStatus).toHaveBeenCalledTimes(statusCount)
    // A later peer still uses the original unexpired credential, never the stale result.
    transport.reconnect()
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(3))
    expect(FakePeer.instances[2].configuration.iceServers![0].credential).toBe('original')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('aborts pending renewal and cancels all its timers when disposed', async () => {
    let expiresAt = 0, resolveRenewal!: (response: Response) => void, renewalSignal: AbortSignal | undefined
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!expiresAt) { expiresAt = Date.now() + 600_000; return relayResponse('first', expiresAt) }
      renewalSignal = init?.signal as AbortSignal
      return new Promise<Response>(resolve => { resolveRenewal = resolve })
    })
    const { transport, callbacks } = await startRelayedHost(fetch)
    await vi.advanceTimersByTimeAsync(expiresAt - 120_000 - Date.now())
    expect(fetch).toHaveBeenCalledTimes(2)
    transport.dispose()
    expect(renewalSignal!.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    const statusCount = vi.mocked(callbacks.onStatus).mock.calls.length
    resolveRenewal(relayResponse('late'))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(callbacks.onStatus).toHaveBeenCalledTimes(statusCount)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it('stops before any network work when WebRTC is unavailable and rechecks on retry', async () => {
    const { host } = await pair()
    const fetch = vi.fn(async () => new Response(JSON.stringify({ iceServers: [], relayAvailable: false })))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('RTCPeerConnection', undefined)
    FakeSocket.instances = []
    FakePeer.instances = []
    vi.useFakeTimers()
    const callbacks: CollaborationCallbacks = { onStatus: vi.fn(), onMessage: vi.fn(), onError: vi.fn() }
    const transport = startCollaboration(host, callbacks, { identity: proofIdentity(host), signalingUrl: 'ws://127.0.0.1:4444' })
    active.push(transport)
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error', issue: 'webrtc-unavailable' }))
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: WEBRTC_UNAVAILABLE_MESSAGE }))
    expect(fetch).not.toHaveBeenCalled()
    expect(FakeSocket.instances).toHaveLength(0)
    expect(FakePeer.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(callbacks.onError).toHaveBeenCalledOnce()
    transport.reconnect()
    expect(vi.getTimerCount()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    transport.reconnect()
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.mocked(callbacks.onStatus).mock.lastCall![0]).not.toHaveProperty('issue')
    transport.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('requires a grant-backed identity before network access and cannot fall back to browser keys alone', async () => {
    const { host } = await pair()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    FakeSocket.instances = []
    vi.useFakeTimers()
    const callbacks: CollaborationCallbacks = { onStatus: vi.fn(), onMessage: vi.fn(), onError: vi.fn() }
    const transport = startCollaboration(host, callbacks)
    active.push(transport)
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ issue: 'identity-unavailable' }))
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: IDENTITY_UNAVAILABLE_MESSAGE }))
    expect(fetch).not.toHaveBeenCalled()
    expect(FakeSocket.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    transport.reconnect()
    expect(fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('requires proof before automatically admitting a requester and refuses a proof copied from another browser key', async () => {
    const { host, guest } = await pair()
    const { callbacks, transport } = start(host)
    const ws = await socket(), hello = helloFields(host)
    ws.receive(await sealSignal(guest, hello), host.room)
    let challenge: Awaited<ReturnType<typeof openSignal>>
    await vi.waitFor(async () => { challenge = (await published(ws, guest)).find(signal => signal.kind === 'challenge') ?? null; expect(challenge).toBeTruthy() })
    expect(FakePeer.instances).toHaveLength(0)
    await expect(transport.send(new Uint8Array([1]))).rejects.toThrow('not connected')
    const payload = JSON.parse(challenge!.payload)
    const { proof } = await createIdentityProof(proofIdentity(guest), { room: host.room, descriptor: host.descriptor, role: 'guest',
      publicKey: (await createIdentity()).publicKey, peerKey: host.hostKey, session: hello.session, peerSession: challenge!.session, challenge: payload.challenge })
    ws.receive(await sealSignal(guest, { kind: 'identity', to: host.hostKey, session: hello.session,
      targetSession: challenge!.session, payload: JSON.stringify({ proof }) }), host.room)
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: IDENTITY_FAILED_MESSAGE })))
    expect(FakePeer.instances).toHaveLength(0)
    expect((await loadRoom(host.scope, host.descriptor.id))?.approvedPeer).toBeUndefined()
  })

  it('refuses an admitted browser that presents a different valid Pubky identity after reconnect', async () => {
    const { host, guest } = await pair()
    await admitPeer(host, guest.identity.publicKey, proofIdentity(guest).owner)
    const { callbacks } = start(host)
    const ws = await socket()
    await authenticateGuest(ws, host, guest, helloFields(host), testIdentity())
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: IDENTITY_FAILED_MESSAGE })))
    expect(FakePeer.instances).toHaveLength(0)
    expect((await loadRoom(host.scope, host.descriptor.id))?.approvedPeerIdentity).toBe(proofIdentity(guest).owner)
  })

  it('refuses to reuse a valid account proof after the verifier rotates its challenge and session', async () => {
    const { host, guest } = await pair()
    const { callbacks, transport } = start(host)
    const ws = await socket(), hello = helloFields(host)
    ws.receive(await sealSignal(guest, hello), host.room)
    let first: Awaited<ReturnType<typeof openSignal>>
    await vi.waitFor(async () => { first = (await published(ws, guest)).find(signal => signal.kind === 'challenge') ?? null; expect(first).toBeTruthy() })
    const { proof } = await createIdentityProof(proofIdentity(guest), { room: host.room, descriptor: host.descriptor, role: 'guest',
      publicKey: guest.identity.publicKey, peerKey: host.hostKey, session: hello.session,
      peerSession: first!.session, challenge: JSON.parse(first!.payload).challenge })
    transport.reconnect()
    ws.receive(await sealSignal(guest, hello), host.room)
    let second: Awaited<ReturnType<typeof openSignal>>
    await vi.waitFor(async () => { second = (await published(ws, guest)).find(signal => signal.kind === 'challenge' && signal.session !== first!.session) ?? null; expect(second).toBeTruthy() })
    expect(JSON.parse(second!.payload).challenge).not.toBe(JSON.parse(first!.payload).challenge)
    ws.receive(await sealSignal(guest, { kind: 'identity', to: host.hostKey, session: hello.session,
      targetSession: second!.session, payload: JSON.stringify({ proof }) }), host.room)
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: IDENTITY_FAILED_MESSAGE })))
    expect(FakePeer.instances).toHaveLength(0)
  })

  it('requires the host account proof before accepting its browser-signed offer', async () => {
    const { host, guest } = await pair()
    const { callbacks } = start(guest)
    const ws = await socket()
    let hello: Awaited<ReturnType<typeof openSignal>>
    await vi.waitFor(async () => { hello = (await published(ws, host)).find(signal => signal.kind === 'hello') ?? null; expect(hello).toBeTruthy() })
    ws.receive(await sealSignal(host, { kind: 'offer', to: guest.identity.publicKey, session: randomToken(16), targetSession: hello!.session, payload: 'v=0\r\n' }), host.room)
    // Wait for a subsequent ordered signal to be processed before checking the rejected offer.
    const session = randomToken(16)
    ws.receive(await sealSignal(host, { kind: 'challenge', to: guest.identity.publicKey, session,
      targetSession: hello!.session, payload: JSON.stringify({ challenge: randomToken(24), proof: { grant: 'invalid', pop: 'invalid' } }) }), host.room)
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: IDENTITY_FAILED_MESSAGE })))
    expect(FakePeer.instances).toHaveLength(0)
    expect((await published(ws, host)).some(signal => signal.kind === 'answer')).toBe(false)
    expect((await loadRoom(guest.scope, guest.descriptor.id))?.hostIdentity).toBeUndefined()
  })

  it('closes the connection and blocks note bytes when either identity grant expires', async () => {
    const { host, guest } = await pair()
    const expiresAt = Math.floor(Date.now() / 1000) + 60
    identities.set(guest.identity.publicKey, testIdentity('pubky-notes', expiresAt))
    await admitPeer(host, guest.identity.publicKey, proofIdentity(guest).owner)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { callbacks, transport } = start(host)
    const ws = await socket()
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(1))
    const channel = FakePeer.instances[0].channel!
    channel.open()
    await transport.send(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(expiresAt * 1000 - Date.now())
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error', issue: 'identity-unavailable' }))
    expect(channel.readyState).toBe('closed')
    expect(ws.readyState).toBe(FakeSocket.CLOSED)
    channel.onmessage!({ data: [...frameMessage(new Uint8Array([9]))][0] })
    await expect(transport.send(new Uint8Array([2]))).rejects.toThrow('not connected')
    expect(callbacks.onMessage).not.toHaveBeenCalled()
    expect(channel.sent).toHaveLength(1)
  })

  it('cleans up and explains a browser that refuses to construct a peer', async () => {
    const { host, guest } = await pair()
    const { transport, callbacks } = start(host)
    const ws = await socket()
    vi.stubGlobal('RTCPeerConnection', class { constructor() { throw new DOMException('Blocked', 'NotSupportedError') } })
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: WEBRTC_UNAVAILABLE_MESSAGE })))
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error', issue: 'webrtc-unavailable' }))
    expect(ws.readyState).toBe(FakeSocket.CLOSED)
    expect(FakePeer.instances).toHaveLength(0)
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    transport.reconnect()
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2))
    expect(vi.mocked(callbacks.onStatus).mock.lastCall![0]).not.toHaveProperty('issue')
  })

  it('automatically admits a verified link holder and persists both browser key and Pubky identity before opening a peer', async () => {
    const { host, guest } = await pair()
    const { transport, callbacks } = start(host)
    const ws = await socket()
    expect(FakePeer.instances).toHaveLength(0)
    await expect(transport.send(new Uint8Array([1]))).rejects.toThrow('not connected')
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(1))
    const admitted = await loadRoom(host.scope, host.descriptor.id)
    expect(admitted?.approvedPeer).toBe(guest.identity.publicKey)
    expect(admitted?.approvedPeerIdentity).toBe(proofIdentity(guest).owner)
    await vi.waitFor(async () => expect((await published(ws, guest)).map(signal => signal.kind)).toEqual(['challenge', 'offer']))
    FakePeer.instances[0].channel!.open()
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connected', relayAvailable: false }))
    await transport.send(new Uint8Array([1, 2, 3]))
    expect(FakePeer.instances[0].channel!.sent).toHaveLength(1)
  })

  it('rejects another link holder once the one collaborator has been admitted', async () => {
    const { host, guest } = await pair()
    await admitPeer(host, guest.identity.publicKey, proofIdentity(guest).owner)
    const outsider = await createGuestRoom(`outsider:${crypto.randomUUID()}`, invitation(host))
    const { callbacks } = start(host)
    const ws = await socket()
    ws.receive(await sealSignal(outsider, helloFields(host)), host.room)
    await vi.waitFor(() => expect(ws.sent.some(packet => JSON.parse(packet).type === 'publish')).toBe(true))
    expect(FakePeer.instances).toHaveLength(0)
    const reply = JSON.parse(ws.sent.find(packet => JSON.parse(packet).type === 'publish')!).data
    expect(await openSignal(reply, outsider, new ReplayGuard())).toMatchObject({ kind: 'reject' })
  })

  it.each([false, true])('keeps a failed connection explanation through automatic retries and clears it on success (relay=%s)', async relay => {
    const { host, guest } = await pair()
    const { transport, callbacks } = start(host, relay ? [{ urls: 'turn:relay.example:3478', username: 'test', credential: 'test' }] : [])
    const ws = await socket()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(async () => expect((await published(ws, guest)).some(signal => signal.kind === 'offer')).toBe(true))
    await answerOffer(ws, host, guest)
    const first = FakePeer.instances[0]
    first.connectionState = 'failed'
    first.onconnectionstatechange!()
    const issue = relay ? 'connection-failed' : 'direct-connection-failed'
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'disconnected', issue, relayAvailable: relay }))
    await vi.advanceTimersByTimeAsync(1500)
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'waiting', issue }))
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(2))
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connecting', issue }))
    FakePeer.instances[1].channel!.open()
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connected' }))
    expect(vi.mocked(callbacks.onStatus).mock.lastCall![0]).not.toHaveProperty('issue')
    // Closing the obsolete connection cannot put its failure back into the UI.
    first.onconnectionstatechange!()
    expect(vi.mocked(callbacks.onStatus).mock.lastCall![0]).not.toHaveProperty('issue')
  })

  it.each([false, true])('distinguishes an unanswered handshake from a negotiated connection timeout (answered=%s)', async answered => {
    const { host, guest } = await pair()
    const { transport, callbacks } = start(host)
    const ws = await socket()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(async () => expect((await published(ws, guest)).some(signal => signal.kind === 'offer')).toBe(true))
    const startedAt = FakePeer.instances[0].createdAt
    if (answered) await answerOffer(ws, host, guest)
    const remaining = 25_000 - (Date.now() - startedAt)
    await vi.advanceTimersByTimeAsync(remaining - 1)
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connecting' }))
    expect(vi.mocked(callbacks.onStatus).mock.lastCall![0]).not.toHaveProperty('issue')
    await vi.advanceTimersByTimeAsync(1)
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'disconnected', issue: answered ? 'direct-connection-failed' : 'handshake-failed' }))
    transport.reconnect()
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'disconnected' }))
    expect(vi.mocked(callbacks.onStatus).mock.lastCall![0]).not.toHaveProperty('issue')
  })

  it('automatically reconnects the durable admitted identity without another approval', async () => {
    const { host, guest } = await pair()
    await admitPeer(host, guest.identity.publicKey, proofIdentity(guest).owner)
    const { callbacks } = start((await loadRoom(host.scope, host.descriptor.id))!)
    const ws = await socket()
    await authenticateGuest(ws, host, guest)
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(1))
  })

  it.each([false, true])('negotiates host presence only from the signed guest answer (supported=%s)', async supported => {
    const { host, guest } = await pair()
    await admitPeer(host, guest.identity.publicKey, proofIdentity(guest).owner)
    const { callbacks, transport } = start(host)
    const ws = await socket()
    const hello = await authenticateGuest(ws, host, guest)
    await vi.waitFor(async () => expect((await published(ws, guest)).some(signal => signal.kind === 'offer')).toBe(true))
    const offer = (await published(ws, guest)).find(signal => signal.kind === 'offer')!
    expect(offer?.kind).toBe('offer')
    expect(supportsPresence(offer!.payload)).toBe(true)
    ws.receive(await sealSignal(guest, { kind: 'answer', to: host.identity.publicKey, session: hello.session, targetSession: offer!.session, payload: supported ? advertisePresence('v=0\r\n') : 'v=0\r\n' }), host.room)
    await vi.waitFor(() => expect(FakePeer.instances[0].remoteDescription?.type).toBe('answer'))
    FakePeer.instances[0].channel!.open()
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connected', presenceSupported: supported }))
    transport.reconnect()
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'disconnected', presenceSupported: false }))
  })

  it.each([false, true])('negotiates guest presence only from the signed host offer (supported=%s)', async supported => {
    const { host, guest } = await pair()
    const { callbacks } = start(guest)
    const ws = await socket()
    const { session, hello } = await authenticateHost(ws, host, guest)
    ws.receive(await sealSignal(host, { kind: 'offer', to: guest.identity.publicKey, session, targetSession: hello.session, payload: supported ? advertisePresence('v=0\r\n') : 'v=0\r\n' }), host.room)
    await vi.waitFor(async () => expect((await published(ws, host)).some(signal => signal.kind === 'answer')).toBe(true))
    const answer = (await published(ws, host)).find(signal => signal.kind === 'answer')!
    expect(answer?.kind).toBe('answer')
    expect(supportsPresence(answer!.payload)).toBe(true)
    const channel = new FakeChannel()
    FakePeer.instances[0].ondatachannel!({ channel })
    channel.open()
    expect(callbacks.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connected', presenceSupported: supported }))
  })

  it('serializes complete received messages and stops old-account callbacks after disposal', async () => {
    const { host, guest } = await pair()
    await admitPeer(host, guest.identity.publicKey, proofIdentity(guest).owner)
    const { transport, callbacks } = start(host)
    const ws = await socket()
    await authenticateGuest(ws, host, guest)
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
    expect(FakePeer.instances).toHaveLength(0)
  })

  it('discards an identity proof that finishes signing after its account scope was disposed', async () => {
    const { host, guest } = await pair(), signer = proofIdentity(host)
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const createProof = vi.fn(async (data: Parameters<CollaborationIdentity['createProof']>[0]) => {
      await waiting
      return signer.createProof(data)
    })
    identities.set(host.identity.publicKey, { ...signer, createProof })
    const { transport, callbacks } = start(host)
    const ws = await socket()
    ws.receive(await sealSignal(guest, helloFields(host)), host.room)
    await vi.waitFor(() => expect(createProof).toHaveBeenCalledOnce())
    transport.dispose()
    release()
    await createProof.mock.results[0].value
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await published(ws, guest))).toHaveLength(0)
    expect(FakePeer.instances).toHaveLength(0)
  })

  it('reports an incoming already-open channel exactly once even if open/connection events follow', async () => {
    const { host, guest } = await pair()
    const { callbacks } = start(guest)
    const ws = await socket()
    const { session, hello } = await authenticateHost(ws, host, guest)
    ws.receive(await sealSignal(host, { kind: 'offer', to: guest.identity.publicKey, session, targetSession: hello.session, payload: 'v=0\r\n' }), host.room)
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
    await admitPeer(host, guest.identity.publicKey, proofIdentity(guest).owner)
    const { callbacks } = start(host)
    const ws = await socket()
    await authenticateGuest(ws, host, guest)
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
