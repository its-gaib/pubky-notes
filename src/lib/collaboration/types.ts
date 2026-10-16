export interface SharedDescriptor {
  id: string
  createdAt: string
  lineage: string
}

export interface Invitation {
  version: 1
  room: string
  secret: string
  hostKey: string
  descriptor: SharedDescriptor
}

export interface StoredRoom extends Invitation {
  scope: string
  role: 'host' | 'guest'
  identity: { publicKey: string; privateKey: CryptoKey }
  approvedPeer?: string
  approvedPeerIdentity?: string
  /** Verified account identity of the invitation's pinned host browser. */
  hostIdentity?: string
  membership?: import('./membership').SignedMembership
}

export type ConnectionState = 'connecting' | 'waiting' | 'connected' | 'disconnected' | 'error'
export interface CollaborationStatus {
  state: ConnectionState
  relayAvailable: boolean
  /** A failed connection attempt remains visible through automatic retries. */
  issue?: 'webrtc-unavailable' | 'identity-unavailable' | 'identity-verification-failed' | 'handshake-failed' | 'direct-connection-failed' | 'connection-failed' | 'room-full' | 'account-already-joined'
  peerFingerprint?: string
  peerIdentity?: string
  /** Remote session whose account proof was verified for this connection. */
  peerSession?: string
  /** Negotiated through authenticated SDP; absent for older app versions. */
  presenceSupported?: boolean
}

export interface CollaborationCallbacks {
  onStatus(status: CollaborationStatus): void
  onMessage(message: Uint8Array): void | Promise<void>
  onError(error: Error): void
}

export interface CollaborationOptions {
  /** Only public grant proofs cross the connection; session secrets stay in the SDK. */
  identity?: CollaborationIdentity
  signalingUrl?: string
  rtcConfiguration?: RTCConfiguration
  iceTransportPolicy?: RTCIceTransportPolicy
  /** Override only in tests or when an application provides its own TURN config. */
  iceEndpoint?: string | null
  /** Internal mesh edge: admission follows direct verification of the fixed peer. */
  pair?: { key: string; owner?: string; authorize(owner: string): Promise<void> }
  /** Shared temporary credentials prevent one TURN API request per mesh edge. */
  getIceConfiguration?: () => Promise<CollaborationIceConfiguration>
}

export interface CollaborationIceConfiguration {
  iceServers: RTCIceServer[]
  relayAvailable: boolean
  expiresAt: number
}

export interface CollaborationPeer {
  key: string
  owner: string
  session: string
  fingerprint?: string
  presenceSupported: boolean
}

export interface GroupCollaborationStatus extends CollaborationStatus {
  peers: CollaborationPeer[]
  participantCount: number
  maxParticipants: 10
  creatorOnline: boolean
}

export interface GroupCollaborationCallbacks {
  onStatus(status: GroupCollaborationStatus): void
  onMessage(message: Uint8Array, peerKey: string): void | Promise<void>
  onError(error: Error): void
}

export interface GroupCollaborationTransport {
  send(message: Uint8Array, peerKey?: string): Promise<void>
  reconnect(): void
  dispose(): void
}

export type GroupCallbacks = GroupCollaborationCallbacks
export type GroupTransport = GroupCollaborationTransport

export interface CollaborationIdentity {
  owner: string
  createProof(data: JsonValue): Promise<CustomPop>
}

export interface CollaborationTransport {
  send(message: Uint8Array): Promise<void>
  reconnect(): void
  dispose(): void
}
import type { CustomPop, JsonValue } from '@synonymdev/pubky'
