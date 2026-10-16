import { decodeBytes, encodeBytes, pinHostIdentity } from './credentials'
import { startDiscovery } from './discovery'
import { MAX_MESSAGE_BYTES } from './framing'
import { createIceConfigurationCache } from './ice-cache'
import { canonicalOwner, IDENTITY_UNAVAILABLE_MESSAGE } from './identity'
import { admitMember, learnMembership, MAX_COLLABORATORS, MAX_MEMBERSHIP_BYTES, verifyMembership } from './membership'
import type { SignedMembership } from './membership'
import { startCollaboration as startPair, webRtcAvailable, WEBRTC_UNAVAILABLE_MESSAGE } from './transport'
import type { CollaborationOptions, CollaborationPeer, CollaborationStatus, CollaborationTransport, GroupCollaborationCallbacks,
  GroupCollaborationStatus, GroupCollaborationTransport, StoredRoom } from './types'

const MAGIC = 0x47
const ROSTER = 1
const DOCUMENT = 2
const ROSTER_ACK = 3
const ROSTER_RETRY_MS = 5_000
const ROSTER_MAX_SENDS = 12
const PENDING_LIMIT = 4
const PENDING_TIMEOUT = 90_000
const QUEUED_LIMIT = MAX_MESSAGE_BYTES * MAX_COLLABORATORS
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

interface Edge {
  key: string
  transport?: CollaborationTransport
  status: CollaborationStatus
  ready: boolean
  closed: boolean
  queue: Promise<void>
  timeout?: ReturnType<typeof setTimeout>
  rosterSent?: string
  rosterAcknowledged?: string
  rosterTimer?: ReturnType<typeof setTimeout>
  rosterSends: number
}

function envelope(type: number, bytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(bytes.byteLength + 2)
  result[0] = MAGIC; result[1] = type; result.set(bytes, 2)
  return result
}

/** A separate room/inbox per edge prevents simultaneous senders overwriting the
 * public HTTP relay. Creator is always offerer on its edges; other edges sort. */
export async function pairRoom(room: StoredRoom, peerKey: string): Promise<StoredRoom> {
  if (decodeBytes(peerKey, 65).length !== 65 || peerKey === room.identity.publicKey) throw new Error('Invalid collaboration peer')
  const keys = [room.identity.publicKey, peerKey].sort()
  const hostKey = keys.includes(room.hostKey) ? room.hostKey : keys[0]
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(['pubky-notes:mesh-edge:v1', room.room, ...keys]))))
  return { version: room.version, scope: room.scope, secret: room.secret, descriptor: room.descriptor,
    identity: room.identity, room: encodeBytes(hash.subarray(0, 24)), hostKey, role: room.identity.publicKey === hostKey ? 'host' : 'guest' }
}

/** Bounded, authenticated full mesh. Creator signs new admissions; admitted
 * peers keep their signed roster and can reconnect when the creator is offline. */
export function startCollaboration(room: StoredRoom, callbacks: GroupCollaborationCallbacks, options: CollaborationOptions = {}): GroupCollaborationTransport {
  const edges = new Map<string, Edge>()
  const cache = createIceConfigurationCache(options.iceEndpoint)
  let discovery: ReturnType<typeof startDiscovery> | undefined
  let disposed = false
  let started = false
  let membership: SignedMembership | undefined
  let creatorOwner = room.hostIdentity
  let admissionQueue = Promise.resolve()
  let queuedSendBytes = 0
  let queuedReceiveBytes = 0
  let groupIssue: CollaborationStatus['issue']
  let startupFailed = false
  let cachedRelayAvailable = false
  const ownKey = room.identity.publicKey
  const ownOwner = options.identity?.owner

  function current(edge: Edge) { return !disposed && !edge.closed && edges.get(edge.key) === edge }
  function report(error: unknown) {
    if (!disposed) callbacks.onError(error instanceof Error ? error : new Error('Collaboration connection failed'))
  }
  function peerFor(edge: Edge): CollaborationPeer | undefined {
    const member = membership?.members.find(candidate => candidate.key === edge.key)
    if (!edge.ready || edge.status.state !== 'connected' || !edge.status.peerSession
      || !member || edge.status.peerIdentity !== member.owner) return
    return { key: edge.key, owner: member.owner, session: edge.status.peerSession,
      fingerprint: edge.status.peerFingerprint, presenceSupported: edge.status.presenceSupported === true }
  }
  function publishStatus() {
    if (disposed) return
    const peers = [...edges.values()].flatMap(edge => { const peer = peerFor(edge); return peer ? [peer] : [] })
    const statuses = [...edges.values()].map(edge => edge.status)
    const ownAdmitted = membership?.members.some(member => member.key === ownKey && member.owner === ownOwner) === true
    const issue = groupIssue ?? statuses.find(status => status.issue)?.issue
    const state: GroupCollaborationStatus['state'] = peers.length ? 'connected'
      : startupFailed || groupIssue === 'room-full' || groupIssue === 'account-already-joined' ? 'error'
      : !started || statuses.some(status => status.state === 'connecting') ? 'connecting'
      : ownAdmitted ? 'waiting'
      : statuses.some(status => status.state === 'error') ? 'error' : 'waiting'
    callbacks.onStatus({ state, peers, participantCount: membership?.members.length ?? 1, maxParticipants: MAX_COLLABORATORS,
      creatorOnline: room.role === 'host' || peers.some(peer => peer.key === room.hostKey),
      relayAvailable: cachedRelayAvailable || statuses.some(status => status.relayAvailable), ...(issue && !peers.length ? { issue } : {}) })
  }
  function closeEdge(edge: Edge) {
    edge.closed = true; edge.ready = false; clearTimeout(edge.timeout); clearTimeout(edge.rosterTimer)
    edge.transport?.dispose()
    if (edges.get(edge.key) === edge) edges.delete(edge.key)
  }
  function enqueue(edge: Edge, operation: () => Promise<void>) {
    edge.queue = edge.queue.then(async () => { if (current(edge)) await operation() }).catch(error => {
      if (current(edge)) { report(error); edge.ready = false; publishStatus() }
    })
    return edge.queue
  }
  function applyMembership(next: SignedMembership) {
    // Different authenticated edges can finish IndexedDB/crypto work out of
    // order. Persisted membership is monotonic; the live snapshot must be too.
    if (!membership || next.revision > membership.revision) membership = next
    room.membership = membership
  }
  function retryRoster(edge: Edge, session: string | undefined) {
    if (!current(edge) || edge.status.state !== 'connected' || edge.status.peerSession !== session) return
    clearTimeout(edge.rosterTimer)
    if (edge.rosterAcknowledged === membership?.signature) return
    edge.rosterTimer = setTimeout(() => {
      if (!current(edge) || edge.status.state !== 'connected' || edge.status.peerSession !== session) return
      void enqueue(edge, async () => {
        if (edge.status.peerSession !== session || edge.rosterAcknowledged === membership?.signature) return
        if (edge.rosterSends >= ROSTER_MAX_SENDS) {
          edge.ready = false
          edge.transport?.reconnect()
          return
        }
        await sendRoster(edge, true)
      })
    }, ROSTER_RETRY_MS)
  }
  async function sendRoster(edge: Edge, force = false) {
    if (!current(edge) || edge.status.state !== 'connected' || !membership || !edge.transport) return
    if (!force && edge.rosterSent === membership.signature) return
    const roster = membership
    const session = edge.status.peerSession
    if (edge.rosterSent !== roster.signature) edge.rosterSends = 0
    edge.rosterSends++
    // Mark before sending: a synchronous test transport (or a very fast peer)
    // can return the acknowledgement before send() resolves.
    edge.rosterSent = roster.signature
    try { await edge.transport.send(envelope(ROSTER, encoder.encode(JSON.stringify(roster)))) }
    finally { retryRoster(edge, session) }
  }
  function canExpose(edge: Edge) {
    return current(edge) && edge.status.state === 'connected' && !!edge.status.peerSession
      && membership?.members.some(member => member.key === ownKey && member.owner === ownOwner) === true
      && membership.members.some(member => member.key === edge.key && member.owner === edge.status.peerIdentity)
  }
  async function activate(edge: Edge) {
    if (!canExpose(edge)) return
    const session = edge.status.peerSession
    await sendRoster(edge)
    if (!canExpose(edge) || edge.status.peerSession !== session || (!edge.ready && !edge.rosterAcknowledged)) return
    edge.ready = true; clearTimeout(edge.timeout); publishStatus()
  }
  function synchronizeRoster() {
    if (disposed || !membership) return
    if (room.role === 'guest' && membership.members.some(member => member.key === ownKey && member.owner === ownOwner)) {
      discovery?.dispose(); discovery = undefined
    }
    for (const member of membership.members) if (member.key !== ownKey) ensureEdge(member.key)
    for (const edge of edges.values()) if (edge.status.state === 'connected') void enqueue(edge, () => activate(edge))
    publishStatus()
  }
  async function authorize(edge: Edge, owner: string) {
    if (!current(edge)) throw new Error('This collaboration connection was closed')
    canonicalOwner(owner)
    if (room.role === 'host') {
      // Serialize in this tab, and compare-and-swap storage across other tabs.
      const admission = admissionQueue.then(async () => {
        if (!current(edge) || !ownOwner) throw new Error('This collaboration connection was closed')
        const next = await admitMember(room, ownOwner, edge.key, owner)
        if (!current(edge)) throw new Error('This collaboration connection was closed')
        applyMembership(next); synchronizeRoster()
      })
      admissionQueue = admission.catch(() => undefined)
      await admission
    } else if (edge.key === room.hostKey) {
      if (creatorOwner && creatorOwner !== owner) throw new Error('The document creator Pubky identity changed')
      await pinHostIdentity(room, owner)
      if (!current(edge)) throw new Error('This collaboration connection was closed')
      creatorOwner = owner
    } else if (!membership?.members.some(member => member.key === edge.key && member.owner === owner)) {
      throw new Error('This account is not an admitted collaborator')
    }
  }
  async function receive(edge: Edge, bytes: Uint8Array) {
    if (!current(edge) || edge.status.state !== 'connected' || !edge.status.peerIdentity || !edge.status.peerSession) return
    const session = edge.status.peerSession
    if (bytes.length < 3 || bytes[0] !== MAGIC) throw new Error('Invalid group collaboration message')
    if (bytes[1] === ROSTER) {
      if (bytes.length > MAX_MEMBERSHIP_BYTES || !creatorOwner) throw new Error('Invalid collaboration membership')
      // The creator may introduce the first roster. Other peers are already
      // account-verified against a previously persisted signed roster.
      if (edge.key !== room.hostKey && !membership?.members.some(member => member.key === edge.key && member.owner === edge.status.peerIdentity)) {
        throw new Error('Unrecognized collaboration member')
      }
      const offered: unknown = JSON.parse(decoder.decode(bytes.subarray(2)))
      const next = await learnMembership(room, offered, creatorOwner)
      if (!current(edge) || edge.status.peerSession !== session) return
      applyMembership(next)
      if (!next.members.some(member => member.key === ownKey && member.owner === ownOwner)) throw new Error('Your browser has not been admitted to this collaboration')
      // Acknowledge the verified packet itself even if storage already held a
      // newer extension, then send our newer roster through normal propagation.
      await edge.transport!.send(envelope(ROSTER_ACK, encoder.encode((offered as SignedMembership).signature)))
      if (!current(edge) || edge.status.peerSession !== session) return
      synchronizeRoster()
      // Do not enqueue onto this same edge while receiving its first roster.
      await activate(edge)
    } else if (bytes[1] === DOCUMENT) {
      if (!canExpose(edge)) throw new Error('Collaboration updates arrived before verified admission')
      // A valid frame can follow the roster ACK before the queued activation
      // callback gets its turn. Finish that activation without losing the frame.
      if (!edge.ready) await activate(edge)
      // A lost ACK can leave one side ready before the other. Once the receipt
      // retries complete, the app reconciles its document with this new edge.
      if (!edge.ready || !canExpose(edge) || edge.status.peerSession !== session) return
      await callbacks.onMessage(bytes.subarray(2), edge.key)
    } else if (bytes[1] === ROSTER_ACK) {
      if (bytes.length > 90 || !canExpose(edge)) throw new Error('Invalid collaboration membership acknowledgement')
      const signature = decoder.decode(bytes.subarray(2))
      if (decodeBytes(signature, 64).length !== 64) throw new Error('Invalid collaboration membership acknowledgement')
      if (signature !== edge.rosterSent) return
      edge.rosterAcknowledged = signature
      if (signature === membership?.signature) clearTimeout(edge.rosterTimer)
      await activate(edge)
    } else throw new Error('Invalid group collaboration message')
  }
  function ensureEdge(key: string) {
    if (disposed || key === ownKey || edges.has(key)) return
    const admitted = membership?.members.some(member => member.key === key)
    if (!admitted && key !== room.hostKey && [...edges.values()].filter(edge => !membership?.members.some(member => member.key === edge.key)).length >= PENDING_LIMIT) return
    const edge: Edge = { key, status: { state: 'connecting', relayAvailable: false }, ready: false, closed: false, queue: Promise.resolve(), rosterSends: 0 }
    edges.set(key, edge)
    if (!admitted && room.role === 'host') edge.timeout = setTimeout(() => {
      if (current(edge) && !membership?.members.some(member => member.key === key)) { closeEdge(edge); publishStatus() }
    }, PENDING_TIMEOUT)
    void pairRoom(room, key).then(child => {
      if (!current(edge)) return
      edge.transport = startPair(child, {
        onStatus(status) {
          if (!current(edge)) return
          const previousSession = edge.status.peerSession
          edge.status = status
          if (status.state !== 'connected' || previousSession !== status.peerSession) {
            edge.ready = false; edge.rosterSent = undefined; edge.rosterAcknowledged = undefined; edge.rosterSends = 0
            clearTimeout(edge.rosterTimer)
          }
          if (status.issue === 'room-full' || status.issue === 'account-already-joined') groupIssue = status.issue
          if (status.state === 'connected') void enqueue(edge, () => activate(edge))
          else publishStatus()
        },
        onError(error) { if (current(edge)) report(error) },
        onMessage(message) {
          if (!current(edge)) return
          if (queuedReceiveBytes + message.length > QUEUED_LIMIT) throw new Error('Too many pending collaboration updates')
          queuedReceiveBytes += message.length
          const session = edge.status.peerSession
          return enqueue(edge, async () => {
            if (edge.status.state === 'connected' && edge.status.peerSession === session) await receive(edge, message)
          }).finally(() => { queuedReceiveBytes -= message.length })
        },
      }, { ...options, pair: { key, owner: membership?.members.find(member => member.key === key)?.owner, authorize: owner => authorize(edge, owner) },
        getIceConfiguration: options.getIceConfiguration ?? cache.get })
    }).catch(error => { if (current(edge)) { closeEdge(edge); report(error); publishStatus() } })
  }

  async function start() {
    if (!webRtcAvailable()) { groupIssue = 'webrtc-unavailable'; throw new Error(WEBRTC_UNAVAILABLE_MESSAGE) }
    if (!options.identity || !ownOwner) { groupIssue = 'identity-unavailable'; throw new Error(IDENTITY_UNAVAILABLE_MESSAGE) }
    canonicalOwner(ownOwner)
    if (options.rtcConfiguration?.iceServers) {
      cachedRelayAvailable = options.rtcConfiguration.iceServers.some(server => (typeof server.urls === 'string' ? [server.urls] : server.urls).some(url => /^turns?:/.test(url)))
    } else {
      // Check TURN once even while the creator waits for their first guest. The
      // same cache supplies every edge and deduplicates any overlapping fetch.
      void (options.getIceConfiguration ?? cache.get)().then(result => {
        if (!disposed) { cachedRelayAvailable = result.relayAvailable; publishStatus() }
      }).catch(() => undefined)
    }
    if (room.role === 'host') {
      creatorOwner = ownOwner
      applyMembership(await admitMember(room, ownOwner))
    } else if (room.membership) {
      if (!creatorOwner) throw new Error('The saved collaboration has no verified creator identity')
      applyMembership(await verifyMembership(room, room.membership, creatorOwner))
      if (!membership!.members.some(member => member.key === ownKey && member.owner === ownOwner)) throw new Error('This Pubky account is not an admitted collaborator')
    }
    if (disposed) return
    started = true
    if (room.role === 'guest') ensureEdge(room.hostKey)
    synchronizeRoster()
    if (room.role === 'host' || !membership?.members.some(member => member.key === ownKey && member.owner === ownOwner)) {
      discovery = startDiscovery(room, { signalingUrl: options.signalingUrl,
        onJoin: key => { if (room.role === 'host') ensureEdge(key) }, onError: report })
    }
    publishStatus()
  }
  // Defer startup callbacks until the caller has received the transport handle.
  void Promise.resolve().then(start).catch(error => { if (!disposed) { startupFailed = true; report(error); publishStatus() } })

  return {
    async send(message, peerKey) {
      if (disposed) return
      if (!message.length || message.length + 2 > MAX_MESSAGE_BYTES) throw new Error('Collaboration update exceeds the message limit')
      const targets = [...edges.values()].filter(edge => edge.ready && canExpose(edge) && (!peerKey || edge.key === peerKey))
      const bytes = envelope(DOCUMENT, message)
      const cost = bytes.length * targets.length
      if (queuedSendBytes + cost > QUEUED_LIMIT) throw new Error('Too many pending collaboration updates')
      queuedSendBytes += cost
      try {
        const results = await Promise.allSettled(targets.map(edge => current(edge) && edge.ready ? edge.transport!.send(bytes) : Promise.resolve()))
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      } finally { queuedSendBytes -= cost }
    },
    reconnect() {
      if (disposed) return
      groupIssue = undefined
      for (const edge of edges.values()) if (!edge.ready || edge.status.state !== 'connected') edge.transport?.reconnect()
      if (room.role === 'guest') ensureEdge(room.hostKey)
      synchronizeRoster(); publishStatus()
    },
    dispose() {
      if (disposed) return
      disposed = true; discovery?.dispose(); cache.dispose()
      for (const edge of edges.values()) closeEdge(edge)
      edges.clear()
    },
  }
}
