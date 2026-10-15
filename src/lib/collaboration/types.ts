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
}

export type ConnectionState = 'connecting' | 'waiting' | 'approval' | 'connected' | 'disconnected' | 'error'
export interface CollaborationStatus {
  state: ConnectionState
  relayAvailable: boolean
  /** A failed connection attempt remains visible through automatic retries. */
  issue?: 'webrtc-unavailable' | 'identity-unavailable' | 'identity-verification-failed' | 'handshake-failed' | 'direct-connection-failed' | 'connection-failed'
  peerFingerprint?: string
  peerIdentity?: string
  /** Negotiated through authenticated SDP; absent for older app versions. */
  presenceSupported?: boolean
}

export interface JoinRequest {
  peerId: string
  fingerprint: string
  owner: string
}

export interface CollaborationCallbacks {
  onStatus(status: CollaborationStatus): void
  onRequest(request: JoinRequest): void
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
}

export interface CollaborationIdentity {
  owner: string
  createProof(data: JsonValue): Promise<CustomPop>
}

export interface CollaborationTransport {
  send(message: Uint8Array): Promise<void>
  approve(peerId: string): Promise<void>
  reject(peerId: string): void
  reconnect(): void
  dispose(): void
}
import type { CustomPop, JsonValue } from '@synonymdev/pubky'
