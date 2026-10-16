import { admitPeer, decodeBytes, fingerprint, loadRoom, pinHostIdentity, randomToken } from './credentials'
import { canonicalOwner, createIdentityProof, IDENTITY_FAILED_MESSAGE, IDENTITY_UNAVAILABLE_MESSAGE, PROOF_MAX_AGE_MS, verifyIdentityProof } from './identity'
import type { IdentityContext, VerifiedIdentity } from './identity'
import type { CustomPop } from '@synonymdev/pubky'
import { frameMessage, MAX_MESSAGE_BYTES, MessageAssembler } from './framing'
import { HttpRelaySocket } from './http-relay'
import type { SignalingSocket } from './http-relay'
import { MAX_SIGNAL_BYTES, openSignal, ReplayGuard, sealSignal } from './signaling'
import { advertisePresence, supportsPresence } from './presence'
import type { Signal, SignalKind } from './signaling'
import type { CollaborationCallbacks, CollaborationOptions, CollaborationStatus, CollaborationTransport, StoredRoom } from './types'

const STUN: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
const SIGNAL_URL = import.meta.env.VITE_COLLAB_SIGNAL_URL || 'https://httprelay.pubky.app/inbox/'
const DEFAULT_ICE_POLICY: RTCIceTransportPolicy = import.meta.env.VITE_COLLAB_RELAY_ONLY === 'true' ? 'relay' : 'all'
const ICE_RENEWAL_RETRIES = [5_000, 10_000, 20_000, 30_000, 30_000]
type IceRefreshResult = 'updated' | 'cached' | 'failed' | 'cancelled'
type IceRequest = { controller: AbortController; promise: Promise<IceRefreshResult>; timeout?: ReturnType<typeof setTimeout> }

export const WEBRTC_UNAVAILABLE_MESSAGE = 'Live collaboration requires WebRTC, which is disabled or unavailable in this browser. Tor Browser does not support this connection method. You can keep editing your private copy.'
export function webRtcAvailable(): boolean { return typeof globalThis.RTCPeerConnection === 'function' }

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error('Collaboration connection failed')
}

function signalingUrl(value: string): string {
  const url = new URL(value)
  if (!['wss:', 'https:'].includes(url.protocol) && !(['ws:', 'http:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Collaboration signaling requires a secure connection')
  if (url.username || url.password || url.hash) throw new Error('Invalid signaling service URL')
  return url.href
}

function validIceServers(value: unknown): value is RTCIceServer[] {
  return Array.isArray(value) && value.length <= 12 && value.every(server => {
    if (!server || typeof server !== 'object') return false
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
    return Array.isArray(urls) && urls.length > 0 && urls.length <= 8 && urls.every(url => typeof url === 'string' && url.length <= 512 && /^(stun|stuns|turn|turns):/.test(url))
      && (server.username === undefined || (typeof server.username === 'string' && server.username.length <= 1024))
      && (server.credential === undefined || (typeof server.credential === 'string' && server.credential.length <= 1024))
  })
}

/** Signaling carries encrypted, identity-signed connection metadata, never note bytes. */
export function startCollaboration(room: StoredRoom, callbacks: CollaborationCallbacks, options: CollaborationOptions = {}): CollaborationTransport {
  let disposed = false
  let socket: SignalingSocket | undefined
  let peer: RTCPeerConnection | undefined
  let channel: RTCDataChannel | undefined
  let localSession = randomToken(16)
  let remoteSession = ''
  let remoteKey = ''
  let peerFingerprint: string | undefined
  let peerIdentity: string | undefined
  let localChallenge = randomToken(24)
  let identityTimer: ReturnType<typeof setTimeout> | undefined
  let verifiedPair: { key: string; session: string; localSession: string; owner: string; expiresAt: number } | undefined
  let exchange: {
    signal: Signal; localSession: string; challenge: string; guestChallenge: string; startedAt: number
    ownProof?: CustomPop; ownIdentity?: VerifiedIdentity; reply?: string
  } | undefined
  const identity = options.identity ? { ...options.identity } : undefined
  let presenceSupported = false
  let state: CollaborationStatus['state'] = 'connecting'
  let issue: CollaborationStatus['issue']
  let relayAvailable = false
  let configuration: RTCConfiguration = { iceServers: STUN, ...options.rtcConfiguration }
  let iceExpiresAt = 0
  let iceRenewAt = 0
  let iceGeneration = 0
  let iceRenewalTimer: ReturnType<typeof setTimeout> | undefined
  let iceRenewalPeer: RTCPeerConnection | undefined
  let iceRequest: IceRequest | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let helloTimer: ReturnType<typeof setInterval> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let networkStarted = false
  let startupGeneration = 0
  let peerRetryTimer: ReturnType<typeof setTimeout> | undefined
  let connectionTimeout: ReturnType<typeof setTimeout> | undefined
  let socketAttempt = 0
  let signalQueue = Promise.resolve()
  let sendQueue = Promise.resolve()
  let sendQueuedBytes = 0
  let receiveQueue = Promise.resolve()
  let receivedQueuedBytes = 0
  let queuedSignals = 0
  let helloSending = false
  let denied = false
  const replay = new ReplayGuard()
  const earlyCandidates: RTCIceCandidateInit[] = []
  let localCandidatesReady = false
  const localCandidates: RTCIceCandidateInit[] = []

  function status(next: CollaborationStatus['state']) {
    state = next
    if (!disposed) callbacks.onStatus({ state, relayAvailable, presenceSupported, ...(issue ? { issue } : {}), ...(peerFingerprint ? { peerFingerprint } : {}), ...(peerIdentity ? { peerIdentity } : {}) })
  }

  function report(error: unknown) {
    if (!disposed) callbacks.onError(errorFrom(error))
  }

  function proofContext(signal: Signal, challenge: string, own: boolean): IdentityContext {
    return { room: room.room, descriptor: room.descriptor, role: own ? room.role : signal.role,
      publicKey: own ? room.identity.publicKey : signal.from, peerKey: own ? signal.from : room.identity.publicKey,
      session: own ? localSession : signal.session, peerSession: own ? signal.session : localSession, challenge }
  }

  function resetIdentity() {
    clearTimeout(identityTimer)
    identityTimer = undefined
    verifiedPair = undefined
    exchange = undefined
    peerIdentity = undefined
    localChallenge = randomToken(24)
  }

  function identityValid() {
    return !!verifiedPair && verifiedPair.localSession === localSession && verifiedPair.expiresAt > Date.now()
  }

  function bindIdentity(signal: Signal, other: VerifiedIdentity, own: VerifiedIdentity) {
    verifiedPair = { key: signal.from, session: signal.session, localSession, owner: other.owner, expiresAt: Math.min(other.expiresAt, own.expiresAt) }
    peerIdentity = other.owner
    const pair = verifiedPair
    const expire = () => {
      if (disposed || verifiedPair !== pair) return
      if (pair.expiresAt > Date.now()) { identityTimer = setTimeout(expire, Math.min(pair.expiresAt - Date.now(), 2_147_000_000)); return }
      stopNetwork()
      issue = 'identity-unavailable'
      status('error')
      report(new Error('Your collaboration identity authorization expired. Sign in again to reconnect.'))
    }
    clearTimeout(identityTimer)
    expire()
  }

  function parseChallenge(payload: string): string {
    const value: unknown = JSON.parse(payload)
    if (!value || typeof value !== 'object' || Object.keys(value).join(',') !== 'challenge'
      || typeof (value as { challenge?: unknown }).challenge !== 'string') throw new Error(IDENTITY_FAILED_MESSAGE)
    const challenge = (value as { challenge: string }).challenge
    if (decodeBytes(challenge, 24).length !== 24) throw new Error(IDENTITY_FAILED_MESSAGE)
    return challenge
  }

  async function refreshIce(force = false): Promise<IceRefreshResult> {
    if (options.iceEndpoint === null || options.rtcConfiguration?.iceServers) {
      relayAvailable = !!configuration.iceServers?.some(server => (typeof server.urls === 'string' ? [server.urls] : server.urls).some(url => /^turns?:/.test(url)))
      return 'cached'
    }
    if (!force && iceExpiresAt > Date.now() + 60_000) return 'cached'
    if (iceRequest) return iceRequest.promise
    const generation = iceGeneration, startedAt = Date.now()
    const request: IceRequest = { controller: new AbortController(), promise: Promise.resolve<IceRefreshResult>('cancelled') }
    iceRequest = request
    request.promise = (async (): Promise<IceRefreshResult> => {
      request.timeout = setTimeout(() => request.controller.abort(), 5_000)
      try {
        const response = await fetch(options.iceEndpoint ?? '/api/collaboration-ice', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pubky-Notes-Collaboration': '1' }, body: '{}', signal: request.controller.signal,
        })
        if (!response.ok) throw new Error('Relay configuration unavailable')
        const result = await response.json() as { iceServers?: unknown; relayAvailable?: unknown; expiresAt?: unknown }
        if (disposed || generation !== iceGeneration) return 'cancelled'
        if (request.controller.signal.aborted || !validIceServers(result.iceServers) || typeof result.relayAvailable !== 'boolean') throw new Error('Invalid relay configuration')
        const available = result.relayAvailable && result.iceServers.some(server => (typeof server.urls === 'string' ? [server.urls] : server.urls).some(url => /^turns?:/.test(url)))
        const expiresAt = typeof result.expiresAt === 'number' && Number.isFinite(result.expiresAt) ? result.expiresAt : startedAt + 5 * 60_000
        // A temporary endpoint fallback must not discard a working allocation or
        // credentials that are still valid. A relay needs time for a fresh ICE exchange.
        if ((relayAvailable && !available) || (available && expiresAt <= Date.now() + 60_000)
          || (force && relayAvailable && expiresAt <= iceExpiresAt)) throw new Error('Relay configuration unavailable')
        configuration = { ...configuration, iceServers: result.iceServers }
        relayAvailable = available
        iceExpiresAt = expiresAt
        iceRenewAt = expiresAt - Math.min(120_000, Math.max(60_000, (expiresAt - startedAt) / 5))
        return 'updated'
      } catch {
        if (disposed || generation !== iceGeneration) return 'cancelled'
        if (!relayAvailable || (iceExpiresAt <= Date.now() && !peer)) {
          relayAvailable = false
          configuration = { ...configuration, iceServers: STUN }
          iceExpiresAt = Date.now() + 30_000
        }
        return 'failed'
      } finally {
        clearTimeout(request.timeout)
        if (iceRequest === request) iceRequest = undefined
      }
    })()
    return request.promise
  }

  function scheduleIceRenewal(connection: RTCPeerConnection) {
    if (options.iceEndpoint === null || options.rtcConfiguration?.iceServers || !relayAvailable || iceRenewalPeer === connection) return
    iceRenewalPeer = connection
    const expiresAt = iceExpiresAt
    let attempt = 0
    const current = () => !disposed && peer === connection && channel?.readyState === 'open'
    const renew = async () => {
      iceRenewalTimer = undefined
      if (!current()) return
      const result = await refreshIce(true)
      if (!current() || result === 'cancelled') return
      if (result === 'updated') {
        // Updating setConfiguration alone does not replace an existing TURN
        // allocation. Rebuild through the pinned, mutually authenticated handshake.
        retryPeer()
        return
      }
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) { retryPeer(); return }
      const delay = ICE_RENEWAL_RETRIES[attempt++]
      iceRenewalTimer = delay === undefined
        ? setTimeout(() => { iceRenewalTimer = undefined; if (current()) retryPeer() }, remaining)
        : setTimeout(() => { void renew() }, Math.min(delay, remaining))
    }
    iceRenewalTimer = setTimeout(() => { void renew() }, Math.max(0, iceRenewAt - Date.now()))
  }

  function closePeer() {
    clearTimeout(iceRenewalTimer)
    iceRenewalTimer = undefined
    iceRenewalPeer = undefined
    iceGeneration++
    clearTimeout(iceRequest?.timeout)
    iceRequest?.controller.abort()
    iceRequest = undefined
    clearTimeout(connectionTimeout)
    clearTimeout(peerRetryTimer)
    connectionTimeout = undefined
    peerRetryTimer = undefined
    const oldPeer = peer, oldChannel = channel
    peer = undefined
    channel = undefined
    remoteSession = ''
    remoteKey = ''
    presenceSupported = false
    earlyCandidates.length = 0
    localCandidates.length = 0
    localCandidatesReady = false
    oldChannel?.close()
    oldPeer?.close()
  }

  function retryPeer() {
    if (disposed) return
    closePeer()
    resetIdentity()
    localSession = randomToken(16)
    status('disconnected')
    peerRetryTimer = setTimeout(() => {
      peerRetryTimer = undefined
      if (!disposed && room.role === 'guest') void hello()
      else if (!disposed) status('waiting')
    }, 1_500)
  }

  function failedConnection() {
    if (disposed) return
    issue = !peer?.localDescription || !peer.remoteDescription ? 'handshake-failed'
      : relayAvailable ? 'connection-failed' : 'direct-connection-failed'
    retryPeer()
  }

  async function publish(kind: SignalKind, to: string, targetSession: string, payload = '') {
    const currentSocket = socket, session = localSession
    if (disposed || currentSocket?.readyState !== WebSocket.OPEN) throw new Error('Signaling is disconnected')
    const data = await sealSignal(room, { to, session, targetSession, kind, payload })
    if (disposed || currentSocket !== socket || currentSocket.readyState !== WebSocket.OPEN || session !== localSession) return
    const packet = JSON.stringify({ type: 'publish', topic: room.room, data })
    if (packet.length > MAX_SIGNAL_BYTES || currentSocket.bufferedAmount > MAX_SIGNAL_BYTES * 4) throw new Error('Signaling capacity exceeded')
    if (currentSocket instanceof HttpRelaySocket) await currentSocket.publish(packet, to)
    else currentSocket.send(packet)
  }

  async function hello() {
    if (disposed || denied || room.role !== 'guest' || channel?.readyState === 'open' || helloSending || socket?.readyState !== WebSocket.OPEN) return
    helloSending = true
    try {
      await publish('hello', room.hostKey, '', JSON.stringify({ challenge: localChallenge }))
      if (!disposed && !peer) status('waiting')
    } catch (error) { report(error) }
    finally { helloSending = false }
  }

  function markConnected(next: RTCDataChannel, connection: RTCPeerConnection) {
    if (disposed || peer !== connection || channel !== next || next.readyState !== 'open' || !identityValid()) return
    clearTimeout(connectionTimeout)
    clearTimeout(peerRetryTimer)
    issue = undefined
    if (state !== 'connected') status('connected')
    scheduleIceRenewal(connection)
  }

  function attachChannel(next: RTCDataChannel, connection: RTCPeerConnection) {
    if (disposed || peer !== connection || channel || !identityValid() || next.label !== 'pubky-notes-v1' || !next.ordered || next.maxRetransmits !== null || next.maxPacketLifeTime !== null) {
      next.close()
      return
    }
    channel = next
    next.binaryType = 'arraybuffer'
    next.bufferedAmountLowThreshold = 256 * 1024
    const assembler = new MessageAssembler()
    next.onopen = () => markConnected(next, connection)
    next.onclose = () => { if (!disposed && peer === connection && channel === next) retryPeer() }
    next.onerror = () => { if (!disposed && peer === connection) report(new Error('Collaboration data connection failed')) }
    next.onmessage = event => {
      if (disposed || peer !== connection || channel !== next || !identityValid()) return
      // Browsers may deliver an incoming channel already open, or deliver its
      // first data task before a queued open callback. Consumers must be able
      // to answer that first message instead of treating it as disconnected.
      markConnected(next, connection)
      try {
        const message = assembler.push(event.data)
        if (!message) return
        if (receivedQueuedBytes + message.length > MAX_MESSAGE_BYTES * 2) throw new Error('Collaboration receiver is overloaded')
        receivedQueuedBytes += message.length
        receiveQueue = receiveQueue.then(async () => {
          if (!disposed && peer === connection && channel === next && identityValid()) await callbacks.onMessage(message)
        }).catch(error => {
          if (peer === connection) { report(error); retryPeer() }
        }).finally(() => { receivedQueuedBytes -= message.length })
      } catch (error) { report(error); retryPeer() }
    }
    markConnected(next, connection)
  }

  function newPeer(key: string, session: string): RTCPeerConnection {
    if (!identityValid() || verifiedPair?.key !== key || verifiedPair.session !== session) throw new Error(IDENTITY_FAILED_MESSAGE)
    closePeer()
    remoteKey = key
    remoteSession = session
    let connection: RTCPeerConnection
    try {
      if (!webRtcAvailable()) throw new Error(WEBRTC_UNAVAILABLE_MESSAGE)
      connection = new globalThis.RTCPeerConnection({ iceTransportPolicy: DEFAULT_ICE_POLICY, ...configuration, ...(options.iceTransportPolicy ? { iceTransportPolicy: options.iceTransportPolicy } : {}) })
    } catch (cause) {
      stopNetwork()
      issue = 'webrtc-unavailable'
      status('error')
      throw new Error(WEBRTC_UNAVAILABLE_MESSAGE, { cause })
    }
    peer = connection
    connection.onicecandidate = event => {
      if (!disposed && peer === connection && event.candidate) {
        if (localCandidatesReady) void publish('ice', key, session, JSON.stringify(event.candidate.toJSON())).catch(report)
        else if (localCandidates.length < 64) localCandidates.push(event.candidate.toJSON())
      }
    }
    connection.ondatachannel = event => attachChannel(event.channel, connection)
    connection.onconnectionstatechange = () => {
      if (disposed || peer !== connection) return
      if (connection.connectionState === 'failed') failedConnection()
      else if (connection.connectionState === 'closed') retryPeer()
      else if (connection.connectionState === 'disconnected') {
        status('disconnected')
        clearTimeout(peerRetryTimer)
        peerRetryTimer = setTimeout(() => { if (peer === connection && connection.connectionState !== 'connected') retryPeer() }, 5_000)
      } else if (connection.connectionState === 'connected' && channel?.readyState === 'open') {
        markConnected(channel, connection)
      }
    }
    connectionTimeout = setTimeout(() => { if (peer === connection) failedConnection() }, 25_000)
    status('connecting')
    return connection
  }

  function flushLocalCandidates(connection: RTCPeerConnection) {
    const authenticated = verifiedPair, key = remoteKey, session = remoteSession
    const current = () => !disposed && peer === connection && verifiedPair === authenticated && identityValid()
      && remoteKey === key && remoteSession === session
    if (!current()) return
    localCandidatesReady = true
    const candidates = localCandidates.splice(0)
    // SDP has already been acknowledged. HTTP ICE delivery can wait on several
    // round trips, so it must not hold the incoming queue ahead of the answer.
    void (async () => {
      for (const candidate of candidates) {
        if (!current()) return
        await publish('ice', key, session, JSON.stringify(candidate))
        if (!current()) return
      }
    })().catch(error => { if (current()) report(error) })
  }

  async function offer(signal: Signal) {
    const authenticated = verifiedPair
    const stored = await loadRoom(room.scope, room.descriptor.id)
    if (disposed || !authenticated || authenticated !== verifiedPair || !identityValid()
      || stored?.room !== room.room || stored.approvedPeer !== signal.from || stored.approvedPeerIdentity !== authenticated.owner) return
    room.approvedPeer = stored.approvedPeer
    room.approvedPeerIdentity = stored.approvedPeerIdentity
    await refreshIce()
    if (disposed || authenticated !== verifiedPair || !identityValid()) return
    peerFingerprint = await fingerprint(signal.from)
    if (disposed || authenticated !== verifiedPair || !identityValid()) return
    const connection = newPeer(signal.from, signal.session)
    attachChannel(connection.createDataChannel('pubky-notes-v1', { ordered: true }), connection)
    const description = await connection.createOffer()
    if (disposed || peer !== connection || !identityValid()) return
    await connection.setLocalDescription(description)
    if (disposed || peer !== connection || !identityValid()) return
    await publish('offer', signal.from, signal.session, advertisePresence(description.sdp ?? ''))
    flushLocalCandidates(connection)
  }

  async function receive(signal: Signal) {
    if (disposed || !identity) return
    if (signal.kind === 'hello' && room.role === 'host') {
      const guestChallenge = parseChallenge(signal.payload)
      const stored = await loadRoom(room.scope, room.descriptor.id)
      if (disposed || stored?.room !== room.room) return
      room.approvedPeer = stored.approvedPeer
      room.approvedPeerIdentity = stored.approvedPeerIdentity
      if (room.approvedPeer && room.approvedPeer !== signal.from) {
        await publish('reject', signal.from, signal.session)
        return
      }
      if (identityValid() && verifiedPair?.key === signal.from && verifiedPair.session === signal.session) return
      if (exchange && exchange.signal.from !== signal.from && Date.now() - exchange.startedAt < PROOF_MAX_AGE_MS) return
      if (exchange?.signal.from === signal.from && exchange.signal.session === signal.session
        && exchange.guestChallenge === guestChallenge && Date.now() - exchange.startedAt < PROOF_MAX_AGE_MS && exchange.ownProof) {
        await publish('challenge', signal.from, signal.session, JSON.stringify({ challenge: exchange.challenge, proof: exchange.ownProof }))
        return
      }
      closePeer()
      resetIdentity()
      localSession = randomToken(16)
      const attempt: NonNullable<typeof exchange> = { signal, localSession, guestChallenge, challenge: randomToken(24), startedAt: Date.now() }
      exchange = attempt
      const own = await createIdentityProof(identity, proofContext(signal, guestChallenge, true))
      if (disposed || exchange !== attempt || attempt.localSession !== localSession) return
      attempt.ownProof = own.proof
      attempt.ownIdentity = own.verified
      await publish('challenge', signal.from, signal.session, JSON.stringify({ challenge: attempt.challenge, proof: own.proof }))
      status('connecting')
      return
    }
    if (signal.targetSession !== localSession) return
    if (signal.kind === 'reject' && room.role === 'guest') {
      denied = true
      closePeer()
      resetIdentity()
      status('error')
      report(new Error('This document already has a collaborator'))
      return
    }
    if (signal.kind === 'challenge' && room.role === 'guest') {
      const value: unknown = JSON.parse(signal.payload)
      if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'challenge,proof') throw new Error(IDENTITY_FAILED_MESSAGE)
      const { challenge, proof } = value as { challenge: string; proof: unknown }
      if (typeof challenge !== 'string' || decodeBytes(challenge, 24).length !== 24) throw new Error(IDENTITY_FAILED_MESSAGE)
      if (exchange?.signal.session === signal.session && exchange.challenge === challenge && exchange.reply && identityValid()) {
        await publish('identity', signal.from, signal.session, exchange.reply)
        return
      }
      const startedSession = localSession
      const other = verifyIdentityProof(proof, proofContext(signal, localChallenge, false), room.hostIdentity)
      closePeer()
      clearTimeout(identityTimer)
      verifiedPair = undefined
      peerIdentity = undefined
      const attempt: NonNullable<typeof exchange> = { signal, localSession, guestChallenge: localChallenge, challenge, startedAt: Date.now() }
      exchange = attempt
      const own = await createIdentityProof(identity, proofContext(signal, challenge, true))
      if (disposed || exchange !== attempt || localSession !== startedSession) return
      await pinHostIdentity(room, other.owner)
      if (disposed || exchange !== attempt || localSession !== startedSession) return
      bindIdentity(signal, other, own.verified)
      if (!identityValid()) return
      attempt.reply = JSON.stringify({ proof: own.proof })
      await publish('identity', signal.from, signal.session, attempt.reply)
      status('waiting')
      return
    }
    if (signal.kind === 'identity' && room.role === 'host') {
      const attempt = exchange
      if (!attempt || !attempt.ownIdentity || attempt.signal.from !== signal.from || attempt.signal.session !== signal.session
        || attempt.localSession !== localSession || Date.now() - attempt.startedAt > PROOF_MAX_AGE_MS) return
      if (identityValid() && verifiedPair?.key === signal.from && verifiedPair.session === signal.session) return
      const value: unknown = JSON.parse(signal.payload)
      if (!value || typeof value !== 'object' || Object.keys(value).join(',') !== 'proof') throw new Error(IDENTITY_FAILED_MESSAGE)
      const other = verifyIdentityProof((value as { proof: unknown }).proof, proofContext(signal, attempt.challenge, false), room.approvedPeerIdentity)
      // Consuming this exchange prevents a second proof from replacing the approved identity.
      bindIdentity(signal, other, attempt.ownIdentity)
      if (!identityValid()) return
      // Possessing the invitation authorizes joining; the verified proof binds
      // that capability to the real Pubky owner before the atomic guest slot is claimed.
      const authenticated = verifiedPair
      await admitPeer(room, signal.from, other.owner)
      if (disposed || exchange !== attempt || authenticated !== verifiedPair || !identityValid()) return
      await offer(signal)
      return
    }
    if (!identityValid() || verifiedPair?.key !== signal.from || verifiedPair.session !== signal.session) return
    if (signal.kind === 'offer' && room.role === 'guest') {
      if (remoteSession === signal.session && peer) return
      const authenticated = verifiedPair
      await refreshIce()
      if (disposed || authenticated !== verifiedPair || signal.targetSession !== localSession || !identityValid()) return
      peerFingerprint = await fingerprint(signal.from)
      if (disposed || authenticated !== verifiedPair || !identityValid()) return
      const connection = newPeer(signal.from, signal.session)
      presenceSupported = supportsPresence(signal.payload)
      await connection.setRemoteDescription({ type: 'offer', sdp: signal.payload })
      if (disposed || peer !== connection || !identityValid()) return
      const answer = await connection.createAnswer()
      if (disposed || peer !== connection || !identityValid()) return
      await connection.setLocalDescription(answer)
      if (disposed || peer !== connection || !identityValid()) return
      await publish('answer', signal.from, signal.session, advertisePresence(answer.sdp ?? ''))
      flushLocalCandidates(connection)
      return
    }
    const connection = peer
    if (!connection || signal.from !== remoteKey || signal.session !== remoteSession) return
    if (signal.kind === 'answer' && room.role === 'host' && connection.signalingState === 'have-local-offer') {
      presenceSupported = supportsPresence(signal.payload)
      await connection.setRemoteDescription({ type: 'answer', sdp: signal.payload })
      for (const candidate of earlyCandidates.splice(0)) await connection.addIceCandidate(candidate)
    } else if (signal.kind === 'ice') {
      const candidate: unknown = JSON.parse(signal.payload)
      if (!candidate || typeof candidate !== 'object') return
      const value = candidate as RTCIceCandidateInit
      if (typeof value.candidate !== 'string' || value.candidate.length > 2048 || (value.sdpMid != null && (typeof value.sdpMid !== 'string' || value.sdpMid.length > 256))
        || (value.sdpMLineIndex != null && (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0 || value.sdpMLineIndex > 64))) return
      if (connection.remoteDescription) await connection.addIceCandidate(value)
      else if (earlyCandidates.length < 64) earlyCandidates.push(value)
    }
  }

  function openSocket() {
    if (disposed) return
    let next: SignalingSocket
    try {
      const url = signalingUrl(options.signalingUrl ?? SIGNAL_URL)
      next = url.startsWith('http') ? new HttpRelaySocket(url, room) : new WebSocket(url)
    }
    catch (error) { status('error'); report(error); return }
    socket = next
    next.onopen = () => {
      if (disposed || socket !== next) return
      socketAttempt = 0
      next.send(JSON.stringify({ type: 'subscribe', topics: [room.room] }))
      if (channel?.readyState !== 'open') status('waiting')
      void hello()
    }
    next.onmessage = event => {
      if (disposed || socket !== next || typeof event.data !== 'string' || event.data.length > MAX_SIGNAL_BYTES || queuedSignals >= 64) return
      let packet: { type?: unknown; topic?: unknown; data?: unknown }
      try { packet = JSON.parse(event.data) } catch { return }
      if (!packet || packet.type !== 'publish' || packet.topic !== room.room) return
      queuedSignals++
      signalQueue = signalQueue.then(async () => {
        if (disposed || socket !== next) return
        const signal = await openSignal(packet.data, room, replay)
        if (signal) await receive(signal)
      }).catch(error => {
        if (error instanceof Error && error.message === IDENTITY_UNAVAILABLE_MESSAGE) {
          stopNetwork()
          issue = 'identity-unavailable'
          status('error')
        } else if (error instanceof Error && error.message === IDENTITY_FAILED_MESSAGE && !identityValid()) {
          issue = 'identity-verification-failed'
          status('error')
        }
        report(error)
      }).finally(() => { queuedSignals-- })
    }
    next.onclose = () => {
      if (disposed || socket !== next) return
      if (channel?.readyState !== 'open') status('disconnected')
      clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(openSocket, Math.min(1000 * 2 ** socketAttempt++, 15_000))
    }
    next.onerror = () => { if (!disposed && socket === next && channel?.readyState !== 'open') status('disconnected') }
  }

  function reconnect() {
    if (disposed) return
    if (!webRtcAvailable()) { beginNetwork(); return }
    denied = false
    issue = undefined
    if (!networkStarted) { beginNetwork(); return }
    retryPeer()
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      clearTimeout(reconnectTimer)
      openSocket()
    }
  }

  const online = () => { if (channel?.readyState !== 'open') reconnect() }
  function stopNetwork() {
    networkStarted = false
    startupGeneration++
    clearInterval(helloTimer)
    clearInterval(heartbeatTimer)
    clearTimeout(reconnectTimer)
    helloTimer = heartbeatTimer = reconnectTimer = undefined
    globalThis.removeEventListener?.('online', online)
    closePeer()
    resetIdentity()
    const previous = socket
    socket = undefined
    previous?.close()
  }
  function beginNetwork() {
    if (disposed) return
    if (!webRtcAvailable()) {
      stopNetwork()
      issue = 'webrtc-unavailable'
      status('error')
      report(new Error(WEBRTC_UNAVAILABLE_MESSAGE))
      return
    }
    try {
      if (!identity || typeof identity.createProof !== 'function') throw new Error()
      canonicalOwner(identity.owner)
    } catch {
      stopNetwork()
      issue = 'identity-unavailable'
      status('error')
      report(new Error(IDENTITY_UNAVAILABLE_MESSAGE))
      return
    }
    if (networkStarted) return
    networkStarted = true
    const attempt = ++startupGeneration
    helloTimer = setInterval(() => { void hello() }, 4_000)
    heartbeatTimer = setInterval(() => {
      if (!disposed && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
    }, 25_000)
    globalThis.addEventListener?.('online', online)
    status('connecting')
    void refreshIce().then(() => { if (!disposed && networkStarted && attempt === startupGeneration) openSocket() }).catch(report)
  }
  beginNetwork()

  return {
    async send(message) {
      if (!(message instanceof Uint8Array) || message.length < 1 || message.length > MAX_MESSAGE_BYTES || sendQueuedBytes + message.length > MAX_MESSAGE_BYTES * 2) throw new Error('Collaboration update exceeds the send limit')
      const connection = channel
      if (disposed || !connection || connection.readyState !== 'open' || !identityValid()) throw new Error('Collaborator is not connected')
      const copy = new Uint8Array(message)
      sendQueuedBytes += copy.length
      const work = sendQueue.then(async () => {
        for (const frame of frameMessage(copy)) {
          if (disposed || channel !== connection || connection.readyState !== 'open' || !identityValid()) throw new Error('Collaborator disconnected')
          if (connection.bufferedAmount > 512 * 1024) await drain(connection)
          if (disposed || channel !== connection || connection.readyState !== 'open' || !identityValid()) throw new Error('Collaborator disconnected')
          connection.send(frame)
        }
      })
      sendQueue = work.catch(() => {}).finally(() => { sendQueuedBytes -= copy.length })
      return work
    },
    reconnect,
    dispose() {
      if (disposed) return
      disposed = true
      stopNetwork()
    },
  }
}

function drain(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= 256 * 1024) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      channel.removeEventListener('bufferedamountlow', ready)
      channel.removeEventListener('close', closed)
    }
    const ready = () => { cleanup(); resolve() }
    const closed = () => { cleanup(); reject(new Error('Collaborator disconnected')) }
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Collaboration connection is too slow')) }, 15_000)
    channel.addEventListener('bufferedamountlow', ready, { once: true })
    channel.addEventListener('close', closed, { once: true })
  })
}
