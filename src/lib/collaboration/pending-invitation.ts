import { IS_TESTNET } from '../../config'
import { validateInvitation } from './credentials'
import type { Invitation } from './types'

export const PENDING_INVITATION_KEY = 'pubky-notes:pending-invitation:v1'
export const PENDING_INVITATION_TTL = 24 * 60 * 60 * 1000
const NETWORK = IS_TESTNET ? 'testnet' : 'mainnet'
const MAX_PENDING_BYTES = 5_000

function sameInvitation(left: Invitation, right: Invitation): boolean {
  return left.room === right.room && left.secret === right.secret && left.hostKey === right.hostKey &&
    left.descriptor.id === right.descriptor.id && left.descriptor.createdAt === right.descriptor.createdAt && left.descriptor.lineage === right.descriptor.lineage
}

/** Keep a not-yet-accepted bearer link in this tab only while the recipient signs in. */
export function savePendingInvitation(invitation: Invitation, now = Date.now()): void {
  validateInvitation(invitation)
  const value = JSON.stringify({ version: 1, network: NETWORK, receivedAt: now, invitation })
  if (value.length > MAX_PENDING_BYTES) throw new Error('The collaboration invitation is too large.')
  sessionStorage.setItem(PENDING_INVITATION_KEY, value)
}

export function readPendingInvitation(now = Date.now()): Invitation | null {
  try {
    const stored = sessionStorage.getItem(PENDING_INVITATION_KEY)
    if (stored === null) return null
    if (stored.length > MAX_PENDING_BYTES) throw new Error('Invalid pending invitation.')
    const value: unknown = JSON.parse(stored)
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'invitation,network,receivedAt,version' ||
        !('version' in value) || value.version !== 1 || !('network' in value) || value.network !== NETWORK ||
        !('receivedAt' in value) || typeof value.receivedAt !== 'number' || !Number.isSafeInteger(value.receivedAt) || value.receivedAt < 0 ||
        value.receivedAt > now + 60_000 || now - value.receivedAt >= PENDING_INVITATION_TTL || !('invitation' in value)) throw new Error('Invalid pending invitation.')
    validateInvitation(value.invitation)
    return value.invitation
  } catch {
    try { sessionStorage.removeItem(PENDING_INVITATION_KEY) } catch { /* Storage may be disabled. */ }
    return null
  }
}

/** A delayed join must never remove a newer invitation opened in the meantime. */
export function clearPendingInvitation(expected?: Invitation): void {
  try {
    if (expected) {
      const current = readPendingInvitation()
      if (!current || !sameInvitation(current, expected)) return
    }
    sessionStorage.removeItem(PENDING_INVITATION_KEY)
  } catch { /* The caller still clears its in-memory invitation. */ }
}
