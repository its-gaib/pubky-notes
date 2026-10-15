import { PublicKey, verifyCustomGrantPop } from '@synonymdev/pubky'
import type { CustomPop, JsonValue } from '@synonymdev/pubky'
import { APP_CLIENT_ID, IS_TESTNET } from '../../config'
import type { CollaborationIdentity, SharedDescriptor } from './types'

export const IDENTITY_UNAVAILABLE_MESSAGE = 'Sign in again with Pubky to verify your identity before collaborating.'
export const IDENTITY_FAILED_MESSAGE = 'The other browser could not prove its Pubky identity. Reconnect to try again.'
export const PROOF_MAX_AGE_MS = 120_000
const MAX_GRANT_BYTES = 4096
const MAX_PROOF_BYTES = 8192

export interface IdentityContext {
  room: string
  descriptor: SharedDescriptor
  role: 'host' | 'guest'
  publicKey: string
  peerKey: string
  session: string
  peerSession: string
  challenge: string
}

export interface VerifiedIdentity { owner: string; expiresAt: number }

export function canonicalOwner(value: string): string {
  if (typeof value !== 'string' || value.length !== 52) throw new Error(IDENTITY_UNAVAILABLE_MESSAGE)
  const key = PublicKey.from(value)
  try {
    if (key.z32() !== value) throw new Error(IDENTITY_UNAVAILABLE_MESSAGE)
    return value
  } finally { key.free() }
}

function proofData(context: IdentityContext): JsonValue {
  return {
    purpose: 'pubky-notes:collaboration-identity:v1',
    origin: location.origin,
    network: IS_TESTNET ? 'testnet' : 'mainnet',
    room: context.room,
    descriptor: { id: context.descriptor.id, createdAt: context.descriptor.createdAt, lineage: context.descriptor.lineage },
    role: context.role,
    publicKey: context.publicKey,
    peerKey: context.peerKey,
    session: context.session,
    peerSession: context.peerSession,
    challenge: context.challenge,
  }
}

function sameJson(left: unknown, right: JsonValue): boolean {
  if (right === null || typeof right !== 'object') return left === right
  if (!left || typeof left !== 'object' || Array.isArray(left) || Array.isArray(right)) return false
  const expected = Object.keys(right)
  return Object.keys(left).length === expected.length && expected.every(key =>
    Object.hasOwn(left, key) && sameJson((left as Record<string, unknown>)[key], right[key]))
}

/** A grant is public; its distinct custom proof cannot be used as a homeserver login proof. */
export function verifyIdentityProof(value: unknown, context: IdentityContext, expectedOwner?: string): VerifiedIdentity {
  try {
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'grant,pop') throw new Error()
    const proof = value as CustomPop
    if (typeof proof.grant !== 'string' || typeof proof.pop !== 'string'
      || proof.grant.length > MAX_GRANT_BYTES || proof.pop.length > MAX_PROOF_BYTES) throw new Error()
    const verified = verifyCustomGrantPop(proof)
    const now = Date.now()
    if (verified.grantClaims.client_id !== APP_CLIENT_ID || verified.identity !== verified.grantClaims.iss
      || (expectedOwner && verified.identity !== expectedOwner)
      || now - verified.iat * 1000 > PROOF_MAX_AGE_MS
      || !sameJson(verified.data, proofData(context))) throw new Error()
    return { owner: canonicalOwner(verified.identity), expiresAt: verified.grantClaims.exp * 1000 }
  } catch { throw new Error(IDENTITY_FAILED_MESSAGE) }
}

export async function createIdentityProof(identity: CollaborationIdentity, context: IdentityContext): Promise<{ proof: CustomPop; verified: VerifiedIdentity }> {
  try {
    const proof = await identity.createProof(proofData(context))
    const verified = verifyIdentityProof(proof, context, identity.owner)
    return { proof, verified }
  } catch {
    // SDK/provider errors can contain authentication context; expose only a fixed action.
    throw new Error(IDENTITY_UNAVAILABLE_MESSAGE)
  }
}
