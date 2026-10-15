// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { encodeBytes } from './credentials'
import { clearPendingInvitation, PENDING_INVITATION_KEY, PENDING_INVITATION_TTL, readPendingInvitation, savePendingInvitation } from './pending-invitation'
import type { Invitation } from './types'

const invitation = (seed = 1): Invitation => ({ version: 1, room: encodeBytes(new Uint8Array(24).fill(seed)), secret: encodeBytes(new Uint8Array(32).fill(seed)),
  hostKey: encodeBytes(new Uint8Array(65).fill(seed)), descriptor: { id: `note-${seed}`, createdAt: '2026-10-15T00:00:00.000Z', lineage: 'shared:00000000-0000-4000-8000-000000000001' } })

beforeEach(() => sessionStorage.clear())

describe('pending invitation storage', () => {
  it('stores a validated invitation in this tab until it is explicitly consumed or dismissed', () => {
    const invite = invitation()
    savePendingInvitation(invite)
    expect(readPendingInvitation()).toEqual(invite)
    expect(localStorage.getItem(PENDING_INVITATION_KEY)).toBeNull()
    clearPendingInvitation(invite)
    expect(readPendingInvitation()).toBeNull()
    expect(sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull()
  })

  it('does not let an older completion clear a newly opened invitation', () => {
    savePendingInvitation(invitation(2))
    clearPendingInvitation(invitation(1))
    expect(readPendingInvitation()).toEqual(invitation(2))
  })

  it('expires stale invitations without refreshing their receipt time', () => {
    savePendingInvitation(invitation(), 1000)
    expect(readPendingInvitation(1000 + PENDING_INVITATION_TTL - 1)).toEqual(invitation())
    expect(readPendingInvitation(1000 + PENDING_INVITATION_TTL)).toBeNull()
    expect(sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull()
  })

  it('removes malformed, oversized, future-dated, and network-mismatched records', () => {
    const now = Date.now()
    savePendingInvitation(invitation(), now)
    const valid = JSON.parse(sessionStorage.getItem(PENDING_INVITATION_KEY)!)
    for (const invalid of ['{', 'x'.repeat(5001), JSON.stringify({ ...valid, extra: true }), JSON.stringify({ ...valid, network: 'another-network' }),
      JSON.stringify({ ...valid, receivedAt: now + 60_001 }), JSON.stringify({ ...valid, invitation: { ...invitation(), secret: 'bad' } })]) {
      sessionStorage.setItem(PENDING_INVITATION_KEY, invalid)
      expect(readPendingInvitation(now)).toBeNull()
      expect(sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull()
    }
  })
})
