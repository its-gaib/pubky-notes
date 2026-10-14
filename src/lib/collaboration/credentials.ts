import type { Invitation, SharedDescriptor, StoredRoom } from './types'

const DATABASE = 'pubky-notes:collaboration:v1'
const ROOM_BYTES = 24
const PUBLIC_KEY_BYTES = 65
let database: Promise<IDBDatabase> | undefined

export function encodeBytes(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeBytes(value: string, maximum = 128 * 1024): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maximum * 4 / 3)) throw new Error('Invalid encoded collaboration data')
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  if (bytes.length > maximum || encodeBytes(bytes) !== value) throw new Error('Invalid encoded collaboration data')
  return bytes
}

export function randomToken(bytes = 24): string {
  return encodeBytes(crypto.getRandomValues(new Uint8Array(bytes)))
}

function requireScope(scope: string) {
  if (!scope || scope === 'guest' || scope.length > 256) throw new Error('Sign in before collaborating')
}

export function validateDescriptor(value: unknown): asserts value is SharedDescriptor {
  if (!value || typeof value !== 'object') throw new Error('Invalid shared document')
  const descriptor = value as SharedDescriptor
  if (Object.keys(value).sort().join(',') !== 'createdAt,id,lineage'
    || typeof descriptor.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(descriptor.id)
    || typeof descriptor.createdAt !== 'string' || descriptor.createdAt.length > 40 || !Number.isFinite(Date.parse(descriptor.createdAt))
    || typeof descriptor.lineage !== 'string' || !/^shared:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(descriptor.lineage)) {
    throw new Error('Invalid shared document')
  }
}

export function validateInvitation(value: unknown): asserts value is Invitation {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'descriptor,hostKey,room,secret,version') throw new Error('Invalid collaboration invitation')
  const invite = value as Invitation
  if (invite.version !== 1 || typeof invite.room !== 'string' || typeof invite.secret !== 'string' || typeof invite.hostKey !== 'string'
    || decodeBytes(invite.room, ROOM_BYTES).length !== ROOM_BYTES || decodeBytes(invite.secret, 32).length !== 32
    || decodeBytes(invite.hostKey, PUBLIC_KEY_BYTES).length !== PUBLIC_KEY_BYTES) throw new Error('Invalid collaboration invitation')
  validateDescriptor(invite.descriptor)
}

export function parseInvitation(hash: string): Invitation | null {
  const parameters = new URLSearchParams(hash.replace(/^#/, ''))
  const encoded = parameters.get('collaborate')
  if (!encoded) return null
  if (parameters.getAll('collaborate').length !== 1 || encoded.length > 4096) throw new Error('Invalid collaboration invitation')
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBytes(encoded, 3072)))
  validateInvitation(value)
  return value
}

export function invitationUrl(room: StoredRoom | Invitation, baseUrl = location.href): string {
  const invitation: Invitation = { version: 1, room: room.room, secret: room.secret, hostKey: room.hostKey, descriptor: room.descriptor }
  validateInvitation(invitation)
  const url = new URL(baseUrl)
  url.hash = new URLSearchParams({ collaborate: encodeBytes(new TextEncoder().encode(JSON.stringify(invitation))) }).toString()
  return url.href
}

export async function createIdentity(): Promise<StoredRoom['identity']> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  return { publicKey: encodeBytes(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))), privateKey: keys.privateKey }
}

export async function fingerprint(publicKey: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', decodeBytes(publicKey, PUBLIC_KEY_BYTES))
  return [...new Uint8Array(bytes)].slice(0, 12).map(byte => byte.toString(16).padStart(2, '0')).join('').match(/.{4}/g)!.join(' ')
}

export async function createHostRoom(scope: string, descriptor: SharedDescriptor): Promise<StoredRoom> {
  requireScope(scope)
  validateDescriptor(descriptor)
  if (await loadRoom(scope, descriptor.id)) throw new Error('This note already has a collaboration room')
  const identity = await createIdentity()
  const room: StoredRoom = { version: 1, scope, role: 'host', room: randomToken(ROOM_BYTES), secret: randomToken(32), hostKey: identity.publicKey, identity, descriptor: { ...descriptor } }
  await saveRoom(room)
  return room
}

export async function createGuestRoom(scope: string, invitation: Invitation): Promise<StoredRoom> {
  requireScope(scope)
  validateInvitation(invitation)
  const existing = await loadRoom(scope, invitation.descriptor.id)
  if (existing) {
    if (existing.room !== invitation.room || existing.secret !== invitation.secret || existing.hostKey !== invitation.hostKey
      || existing.descriptor.createdAt !== invitation.descriptor.createdAt || existing.descriptor.lineage !== invitation.descriptor.lineage) throw new Error('This note already belongs to a different collaboration')
    return existing
  }
  const room: StoredRoom = { ...invitation, descriptor: { ...invitation.descriptor }, scope, role: 'guest', identity: await createIdentity() }
  await saveRoom(room)
  return room
}

async function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('rooms', { keyPath: ['scope', 'descriptor.id'] })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open collaboration storage'))
  })
  return database
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('rooms', mode)
    const request = operation(tx.objectStore('rooms'))
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Unable to save collaboration credentials'))
  })
}

export async function loadRoom(scope: string, noteId: string): Promise<StoredRoom | undefined> {
  requireScope(scope)
  return transaction('readonly', store => store.get([scope, noteId]))
}

/** Persist an admission before sending an offer. Keys remain local to this origin and account. */
export async function saveRoom(room: StoredRoom): Promise<void> {
  requireScope(room.scope)
  await transaction('readwrite', store => store.put(room))
}

/** A single transaction prevents two host tabs from admitting different guests. */
export async function admitPeer(room: StoredRoom, publicKey: string): Promise<void> {
  if (room.role !== 'host' || decodeBytes(publicKey, 65).length !== 65) throw new Error('Invalid collaborator admission')
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('rooms', 'readwrite')
    const store = tx.objectStore('rooms')
    const request = store.get([room.scope, room.descriptor.id])
    let failure: Error | undefined
    request.onsuccess = () => {
      const current = request.result as StoredRoom | undefined
      if (!current || current.room !== room.room || (current.approvedPeer && current.approvedPeer !== publicKey)) {
        failure = new Error('This room already has a collaborator or was closed')
        tx.abort()
        return
      }
      store.put({ ...current, approvedPeer: publicKey })
    }
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('Unable to save collaborator admission'))
  })
  room.approvedPeer = publicKey
}

export async function deleteRoom(scope: string, noteId: string): Promise<void> {
  requireScope(scope)
  await transaction('readwrite', store => store.delete([scope, noteId]))
}
