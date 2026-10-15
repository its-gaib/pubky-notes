import { decodeBytes, encodeBytes, randomToken } from './credentials'
import type { StoredRoom } from './types'

export const MAX_SIGNAL_BYTES = 64 * 1024
const MAX_PLAINTEXT_BYTES = 32 * 1024
const MAX_AGE = 60_000
const encoder = new TextEncoder()

export type SignalKind = 'hello' | 'challenge' | 'identity' | 'offer' | 'answer' | 'ice' | 'reject'
export interface Signal {
  version: 1
  room: string
  from: string
  to: string
  role: 'host' | 'guest'
  session: string
  targetSession: string
  kind: SignalKind
  nonce: string
  sentAt: number
  payload: string
}

interface EncryptedSignal { version: 1; iv: string; ciphertext: string }

/** Invalid packets never evict valid nonces; bounded memory and a short acceptance window. */
export class ReplayGuard {
  private readonly nonces = new Map<string, number>()

  accept(nonce: string, sentAt: number, now = Date.now()): boolean {
    if (Math.abs(now - sentAt) > MAX_AGE) return false
    for (const [key, time] of this.nonces) if (time < now - MAX_AGE) this.nonces.delete(key)
    if (this.nonces.has(nonce) || this.nonces.size >= 2048) return false
    this.nonces.set(nonce, sentAt)
    return true
  }
}

function exactKeys(value: object, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected
}

function validateSignal(value: unknown): asserts value is Signal {
  if (!value || typeof value !== 'object'
    || !exactKeys(value, 'from,kind,nonce,payload,role,room,sentAt,session,targetSession,to,version')) throw new Error('Invalid signaling message')
  const signal = value as Signal
  if (signal.version !== 1 || !['host', 'guest'].includes(signal.role)
    || !['hello', 'challenge', 'identity', 'offer', 'answer', 'ice', 'reject'].includes(signal.kind)
    || typeof signal.room !== 'string' || decodeBytes(signal.room, 24).length !== 24
    || typeof signal.from !== 'string' || decodeBytes(signal.from, 65).length !== 65
    || typeof signal.to !== 'string' || decodeBytes(signal.to, 65).length !== 65
    || typeof signal.session !== 'string' || decodeBytes(signal.session, 16).length !== 16
    || typeof signal.targetSession !== 'string' || (signal.targetSession !== '' && decodeBytes(signal.targetSession, 16).length !== 16)
    || typeof signal.nonce !== 'string' || decodeBytes(signal.nonce, 16).length !== 16
    || !Number.isSafeInteger(signal.sentAt) || typeof signal.payload !== 'string'
    || encoder.encode(signal.payload).length > 24 * 1024) throw new Error('Invalid signaling message')
  if ((signal.kind === 'hello' && (signal.role !== 'guest' || signal.targetSession !== ''))
    || (signal.kind === 'challenge' && signal.role !== 'host')
    || (signal.kind === 'identity' && signal.role !== 'guest')
    || (signal.kind === 'offer' && signal.role !== 'host')
    || (signal.kind === 'answer' && signal.role !== 'guest')
    || (signal.kind === 'reject' && (signal.role !== 'host' || signal.payload !== ''))
    || (signal.kind !== 'hello' && !signal.targetSession)
    || (signal.kind === 'ice' && encoder.encode(signal.payload).length > 4096)) throw new Error('Invalid signaling message')
}

async function roomKey(room: StoredRoom): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', decodeBytes(room.secret, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function sealSignal(room: StoredRoom, fields: Pick<Signal, 'to' | 'session' | 'targetSession' | 'kind' | 'payload'>): Promise<EncryptedSignal> {
  const body: Signal = { version: 1, room: room.room, from: room.identity.publicKey, role: room.role, nonce: randomToken(16), sentAt: Date.now(), ...fields }
  validateSignal(body)
  const message = JSON.stringify(body)
  const signature = encodeBytes(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, room.identity.privateKey, encoder.encode(message))))
  const plaintext = encoder.encode(JSON.stringify({ message, signature }))
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('Signaling message is too large')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(room.room) }, await roomKey(room), plaintext)
  return { version: 1, iv: encodeBytes(iv), ciphertext: encodeBytes(new Uint8Array(ciphertext)) }
}

export async function openSignal(value: unknown, room: StoredRoom, replay: ReplayGuard): Promise<Signal | null> {
  try {
    if (!value || typeof value !== 'object' || !exactKeys(value, 'ciphertext,iv,version')) return null
    const encrypted = value as EncryptedSignal
    if (encrypted.version !== 1 || typeof encrypted.iv !== 'string' || typeof encrypted.ciphertext !== 'string') return null
    const iv = decodeBytes(encrypted.iv, 12)
    if (iv.length !== 12) return null
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(room.room) }, await roomKey(room), decodeBytes(encrypted.ciphertext, MAX_PLAINTEXT_BYTES + 16))
    const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    if (!envelope || typeof envelope !== 'object' || !exactKeys(envelope, 'message,signature')) return null
    const { message, signature } = envelope as { message: string; signature: string }
    if (typeof message !== 'string' || typeof signature !== 'string') return null
    const body: unknown = JSON.parse(message)
    validateSignal(body)
    if (body.room !== room.room || body.to !== room.identity.publicKey || body.from === room.identity.publicKey
      || body.role === room.role || (room.role === 'guest' && body.from !== room.hostKey)
      || Math.abs(Date.now() - body.sentAt) > MAX_AGE) return null
    const publicKey = await crypto.subtle.importKey('raw', decodeBytes(body.from, 65), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, decodeBytes(signature, 64), encoder.encode(message))
    if (!valid || !replay.accept(body.nonce, body.sentAt)) return null
    return body
  } catch {
    return null
  }
}
