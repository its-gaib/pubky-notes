import { admitPeer, fingerprint, loadRoom, randomToken } from './credentials'
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
  let presenceSupported = false
  let pending: Signal | undefined
  let state: CollaborationStatus['state'] = 'connecting'
  let issue: CollaborationStatus['issue']
  let relayAvailable = false
  let configuration: RTCConfiguration = { iceServers: STUN, ...options.rtcConfiguration }
  let iceExpiresAt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
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
  let fetchAbort = new AbortController()
  let localCandidatesReady = false
  const localCandidates: RTCIceCandidateInit[] = []

  function status(next: CollaborationStatus['state']) {
    state = next
    if (!disposed) callbacks.onStatus({ state, relayAvailable, presenceSupported, ...(issue ? { issue } : {}), ...(peerFingerprint ? { peerFingerprint } : {}) })
  }

  function report(error: unknown) {
    if (!disposed) callbacks.onError(errorFrom(error))
  }

  async function refreshIce() {
    if (options.iceEndpoint === null || options.rtcConfiguration?.iceServers) {
      relayAvailable = !!configuration.iceServers?.some(server => (typeof server.urls === 'string' ? [server.urls] : server.urls).some(url => /^turns?:/.test(url)))
      return
    }
    if (iceExpiresAt > Date.now() + 60_000) return
    fetchAbort = new AbortController()
    const timeout = setTimeout(() => fetchAbort.abort(), 5_000)
    try {
      const response = await fetch(options.iceEndpoint ?? '/api/collaboration-ice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pubky-Notes-Collaboration': '1' }, body: '{}', signal: fetchAbort.signal,
      })
      if (!response.ok) throw new Error('Relay configuration unavailable')
      const result = await response.json() as { iceServers?: unknown; relayAvailable?: unknown; expiresAt?: unknown }
      if (!validIceServers(result.iceServers) || typeof result.relayAvailable !== 'boolean') throw new Error('Invalid relay configuration')
      configuration = { ...configuration, iceServers: result.iceServers }
      relayAvailable = result.relayAvailable && result.iceServers.some(server => (typeof server.urls === 'string' ? [server.urls] : server.urls).some(url => /^turns?:/.test(url)))
      iceExpiresAt = typeof result.expiresAt === 'number' && Number.isFinite(result.expiresAt) ? result.expiresAt : Date.now() + 5 * 60_000
    } catch {
      // A missing relay must be visible in status, while direct ICE remains usable.
      relayAvailable = false
      configuration = { ...configuration, iceServers: STUN }
      iceExpiresAt = Date.now() + 30_000
    } finally {
      clearTimeout(timeout)
    }
  }

  function closePeer() {
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
    issue = relayAvailable ? 'connection-failed' : 'direct-connection-failed'
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
      await publish('hello', room.hostKey, '')
      if (!disposed && !peer) status('waiting')
    } catch (error) { report(error) }
    finally { helloSending = false }
  }

  function markConnected(next: RTCDataChannel, connection: RTCPeerConnection) {
    if (disposed || peer !== connection || channel !== next || next.readyState !== 'open') return
    clearTimeout(connectionTimeout)
    clearTimeout(peerRetryTimer)
    issue = undefined
    if (state !== 'connected') status('connected')
  }

  function attachChannel(next: RTCDataChannel, connection: RTCPeerConnection) {
    if (disposed || peer !== connection || channel || next.label !== 'pubky-notes-v1' || !next.ordered || next.maxRetransmits !== null || next.maxPacketLifeTime !== null) {
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
      if (disposed || peer !== connection || channel !== next) return
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
          if (!disposed && peer === connection && channel === next) await callbacks.onMessage(message)
        }).catch(error => {
          if (peer === connection) { report(error); retryPeer() }
        }).finally(() => { receivedQueuedBytes -= message.length })
      } catch (error) { report(error); retryPeer() }
    }
    markConnected(next, connection)
  }

  function newPeer(key: string, session: string): RTCPeerConnection {
    closePeer()
    remoteKey = key
    remoteSession = session
    const connection = new RTCPeerConnection({ iceTransportPolicy: DEFAULT_ICE_POLICY, ...configuration, ...(options.iceTransportPolicy ? { iceTransportPolicy: options.iceTransportPolicy } : {}) })
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

  async function flushLocalCandidates(connection: RTCPeerConnection) {
    if (disposed || peer !== connection) return
    localCandidatesReady = true
    for (const candidate of localCandidates.splice(0)) {
      if (disposed || peer !== connection) return
      await publish('ice', remoteKey, remoteSession, JSON.stringify(candidate))
    }
  }

  async function offer(signal: Signal) {
    // Reload durable admission so a second tab cannot admit another identity.
    const stored = await loadRoom(room.scope, room.descriptor.id)
    if (disposed || stored?.room !== room.room || stored.approvedPeer !== signal.from) return
    room.approvedPeer = stored.approvedPeer
    await refreshIce()
    if (disposed) return
    localSession = randomToken(16)
    peerFingerprint = await fingerprint(signal.from)
    if (disposed) return
    const connection = newPeer(signal.from, signal.session)
    attachChannel(connection.createDataChannel('pubky-notes-v1', { ordered: true }), connection)
    const description = await connection.createOffer()
    if (disposed || peer !== connection) return
    await connection.setLocalDescription(description)
    if (disposed || peer !== connection) return
    await publish('offer', signal.from, signal.session, advertisePresence(description.sdp ?? ''))
    await flushLocalCandidates(connection)
  }

  async function receive(signal: Signal) {
    if (disposed) return
    if (signal.kind === 'hello' && room.role === 'host') {
      const stored = await loadRoom(room.scope, room.descriptor.id)
      if (disposed || stored?.room !== room.room) return
      room.approvedPeer = stored.approvedPeer
      if (room.approvedPeer && room.approvedPeer !== signal.from) {
        await publish('reject', signal.from, signal.session)
        return
      }
      if (room.approvedPeer === signal.from) {
        if (remoteKey === signal.from && remoteSession === signal.session && peer && !['failed', 'closed'].includes(peer.connectionState)) return
        await offer(signal)
        return
      }
      if (pending && pending.from !== signal.from) return
      const first = !pending
      pending = signal
      status('approval')
      if (first) {
        const requestFingerprint = await fingerprint(signal.from)
        if (!disposed) callbacks.onRequest({ peerId: signal.from, fingerprint: requestFingerprint })
      }
      return
    }
    if (signal.targetSession !== localSession) return
    if (signal.kind === 'reject' && room.role === 'guest') {
      denied = true
      closePeer()
      status('error')
      report(new Error('The host declined this invitation or already has a collaborator'))
      return
    }
    if (signal.kind === 'offer' && room.role === 'guest') {
      if (remoteSession === signal.session && peer) return
      await refreshIce()
      if (disposed || signal.targetSession !== localSession) return
      peerFingerprint = await fingerprint(signal.from)
      const connection = newPeer(signal.from, signal.session)
      presenceSupported = supportsPresence(signal.payload)
      await connection.setRemoteDescription({ type: 'offer', sdp: signal.payload })
      if (disposed || peer !== connection) return
      const answer = await connection.createAnswer()
      await connection.setLocalDescription(answer)
      if (disposed || peer !== connection) return
      await publish('answer', signal.from, signal.session, advertisePresence(answer.sdp ?? ''))
      await flushLocalCandidates(connection)
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
      }).catch(report).finally(() => { queuedSignals-- })
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
    denied = false
    issue = undefined
    retryPeer()
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      clearTimeout(reconnectTimer)
      openSocket()
    }
  }

  const helloTimer = setInterval(() => { void hello() }, 4_000)
  const heartbeatTimer = setInterval(() => {
    if (!disposed && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
  }, 25_000)
  const online = () => { if (channel?.readyState !== 'open') reconnect() }
  globalThis.addEventListener?.('online', online)
  status('connecting')
  void refreshIce().then(() => { if (!disposed) openSocket() }).catch(report)

  return {
    async send(message) {
      if (!(message instanceof Uint8Array) || message.length < 1 || message.length > MAX_MESSAGE_BYTES || sendQueuedBytes + message.length > MAX_MESSAGE_BYTES * 2) throw new Error('Collaboration update exceeds the send limit')
      const connection = channel
      if (disposed || !connection || connection.readyState !== 'open') throw new Error('Collaborator is not connected')
      const copy = new Uint8Array(message)
      sendQueuedBytes += copy.length
      const work = sendQueue.then(async () => {
        for (const frame of frameMessage(copy)) {
          if (disposed || channel !== connection || connection.readyState !== 'open') throw new Error('Collaborator disconnected')
          if (connection.bufferedAmount > 512 * 1024) await drain(connection)
          if (disposed || channel !== connection || connection.readyState !== 'open') throw new Error('Collaborator disconnected')
          connection.send(frame)
        }
      })
      sendQueue = work.catch(() => {}).finally(() => { sendQueuedBytes -= copy.length })
      return work
    },
    async approve(peerId) {
      const request = pending
      if (disposed || room.role !== 'host' || !request || request.from !== peerId) throw new Error('This join request is no longer available')
      await admitPeer(room, peerId)
      if (disposed) return
      pending = undefined
      await offer(request)
    },
    reject(peerId) {
      const request = pending
      if (disposed || room.role !== 'host' || !request || request.from !== peerId) return
      pending = undefined
      void publish('reject', peerId, request.session).catch(report)
      status('waiting')
    },
    reconnect,
    dispose() {
      if (disposed) return
      disposed = true
      fetchAbort.abort()
      clearInterval(helloTimer)
      clearInterval(heartbeatTimer)
      clearTimeout(reconnectTimer)
      globalThis.removeEventListener?.('online', online)
      closePeer()
      socket?.close()
      socket = undefined
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
