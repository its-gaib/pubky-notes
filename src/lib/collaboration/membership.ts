import { compareAndSwapMembership, decodeBytes, encodeBytes, loadRoom, validateDescriptor } from './credentials'
import { canonicalOwner } from './identity'
import type { SharedDescriptor, StoredRoom } from './types'

export const MAX_COLLABORATORS = 10
export const MAX_MEMBERSHIP_BYTES = 16 * 1024
export interface RoomMember { key: string; owner: string }
export interface SignedMembership {
  version: 1
  room: string
  hostKey: string
  descriptor: SharedDescriptor
  revision: number
  members: RoomMember[]
  signature: string
}
const encoder = new TextEncoder()

function fail(message = 'Invalid collaboration membership'): never { throw new Error(message) }
function admissionError(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
function exact(value: object, keys: string) { return Object.keys(value).sort().join(',') === keys }
function validKey(key: unknown): key is string { return typeof key === 'string' && decodeBytes(key, 65).length === 65 }

function unsigned(value: Omit<SignedMembership, 'signature'>) {
  return { version: value.version, room: value.room, hostKey: value.hostKey,
    descriptor: { id: value.descriptor.id, createdAt: value.descriptor.createdAt, lineage: value.descriptor.lineage },
    revision: value.revision, members: value.members.map(member => ({ key: member.key, owner: member.owner })) }
}

/** Only the invitation's pinned browser key can extend membership. Every live
 * edge separately proves its Pubky identity; this signature is not that proof. */
export async function verifyMembership(room: StoredRoom, value: unknown, creatorOwner: string): Promise<SignedMembership> {
  if (!value || typeof value !== 'object' || !exact(value, 'descriptor,hostKey,members,revision,room,signature,version')) fail()
  const membership = value as SignedMembership
  validateDescriptor(membership.descriptor)
  if (membership.version !== 1 || membership.room !== room.room || membership.hostKey !== room.hostKey
    || membership.descriptor.id !== room.descriptor.id || membership.descriptor.createdAt !== room.descriptor.createdAt
    || membership.descriptor.lineage !== room.descriptor.lineage || !Array.isArray(membership.members)
    || membership.members.length < 1 || membership.members.length > MAX_COLLABORATORS
    || membership.revision !== membership.members.length || typeof membership.signature !== 'string'
    || decodeBytes(membership.signature, 64).length !== 64) fail()
  const keys = new Set<string>(), owners = new Set<string>()
  for (const member of membership.members) {
    if (!member || typeof member !== 'object' || !exact(member, 'key,owner') || !validKey(member.key)
      || typeof member.owner !== 'string' || canonicalOwner(member.owner) !== member.owner
      || keys.has(member.key) || owners.has(member.owner)) fail()
    keys.add(member.key); owners.add(member.owner)
  }
  if (membership.members[0].key !== room.hostKey || membership.members[0].owner !== canonicalOwner(creatorOwner)) fail()
  const data = encoder.encode(JSON.stringify(unsigned(membership)))
  if (data.length > MAX_MEMBERSHIP_BYTES) fail()
  const key = await crypto.subtle.importKey('raw', decodeBytes(room.hostKey, 65), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decodeBytes(membership.signature, 64), data)) fail()
  return structuredClone(membership)
}

function extendsMembership(current: SignedMembership, next: SignedMembership): boolean {
  return next.members.length >= current.members.length && current.members.every((member, index) =>
    member.key === next.members[index].key && member.owner === next.members[index].owner)
}

async function signMembership(room: StoredRoom, members: RoomMember[]): Promise<SignedMembership> {
  if (room.role !== 'host' || room.identity.publicKey !== room.hostKey) fail('Only the document creator can admit new collaborators')
  const body = unsigned({ version: 1, room: room.room, hostKey: room.hostKey, descriptor: room.descriptor, revision: members.length, members })
  const signature = encodeBytes(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, room.identity.privateKey, encoder.encode(JSON.stringify(body)))))
  return { ...body, signature }
}

/** Membership is append-only for this invitation: at most ten distinct accounts
 * and one admitted browser key per account. Offline members retain their slot. */
export async function admitMember(room: StoredRoom, creatorOwner: string, key = room.hostKey, owner = creatorOwner): Promise<SignedMembership> {
  if (room.role !== 'host' || room.identity.publicKey !== room.hostKey || !validKey(key)) fail('Invalid collaborator admission')
  canonicalOwner(creatorOwner); canonicalOwner(owner)
  for (let attempt = 0; attempt < 24; attempt++) {
    const stored = await loadRoom(room.scope, room.descriptor.id)
    if (!stored || stored.room !== room.room || stored.hostKey !== room.hostKey) fail('This collaboration was closed')
    const current = stored.membership ? await verifyMembership(room, stored.membership, creatorOwner) : undefined
    const members = current?.members ?? [{ key: room.hostKey, owner: creatorOwner }]
    const existingKey = members.find(member => member.key === key)
    if (existingKey && existingKey.owner !== owner) fail('This browser key belongs to a different Pubky identity')
    const existingOwner = members.find(member => member.owner === owner)
    if (existingOwner && existingOwner.key !== key) admissionError('account-already-joined', 'This Pubky account already joined from another browser. Use that browser to reconnect.')
    if (!existingKey && members.length >= MAX_COLLABORATORS) admissionError('room-full', 'This collaboration already has ten participants, including its creator.')
    if (existingKey && current) { room.membership = current; room.hostIdentity = creatorOwner; return current }
    const next = await signMembership(room, existingKey ? members : [...members, { key, owner }])
    if (await compareAndSwapMembership(room, current?.signature, next)) {
      room.membership = next; room.hostIdentity = creatorOwner
      return next
    }
  }
  fail('Collaboration membership changed repeatedly. Reconnect to try again.')
}

/** Persist a verified extension without allowing stale packets to roll back or
 * overwrite a roster learned concurrently by another tab. */
export async function learnMembership(room: StoredRoom, value: unknown, creatorOwner: string): Promise<SignedMembership> {
  const next = await verifyMembership(room, value, creatorOwner)
  for (let attempt = 0; attempt < 24; attempt++) {
    const stored = await loadRoom(room.scope, room.descriptor.id)
    if (!stored || stored.room !== room.room || stored.hostKey !== room.hostKey) fail('This collaboration was closed')
    const current = stored.membership ? await verifyMembership(room, stored.membership, creatorOwner) : undefined
    if (current) {
      if (extendsMembership(next, current)) { room.membership = current; room.hostIdentity = creatorOwner; return current }
      if (!extendsMembership(current, next)) fail('The creator signed conflicting collaboration membership')
    }
    if (await compareAndSwapMembership(room, current?.signature, next)) {
      room.membership = next; room.hostIdentity = creatorOwner
      return next
    }
  }
  fail('Collaboration membership changed repeatedly. Reconnect to try again.')
}
