import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGuestRoom, createHostRoom, createIdentity, encodeBytes, loadRoom } from './credentials'
import { testIdentity } from './identity.test-helpers'
import { admitMember, learnMembership, verifyMembership } from './membership'
import type { SignedMembership } from './membership'
import type { Invitation, StoredRoom } from './types'

beforeEach(() => vi.stubGlobal('location', new URL('https://notes.example')))
const invitation = (room: StoredRoom): Invitation => ({ version: 1, room: room.room, secret: room.secret, hostKey: room.hostKey, descriptor: room.descriptor })
async function host() {
  return { room: await createHostRoom(`host:${crypto.randomUUID()}`, { id: crypto.randomUUID(), createdAt: new Date().toISOString(), lineage: `shared:${crypto.randomUUID()}` }), owner: testIdentity().owner }
}
async function member() { return { key: (await createIdentity()).publicKey, owner: testIdentity().owner } }

describe('signed bounded group membership', () => {
  it('counts the creator, admits ten unique users, rejects eleven, and allows reconnects', async () => {
    const { room, owner } = await host()
    expect((await admitMember(room, owner)).members).toEqual([{ key: room.hostKey, owner }])
    const users = await Promise.all(Array.from({ length: 10 }, member))
    for (const user of users.slice(0, 9)) await admitMember(room, owner, user.key, user.owner)
    expect(room.membership?.members).toHaveLength(10)
    const reconnect = await admitMember(room, owner, users[0].key, users[0].owner)
    expect(reconnect.members).toHaveLength(10)
    await expect(admitMember(room, owner, users[9].key, users[9].owner)).rejects.toMatchObject({ code: 'room-full' })
    expect((await loadRoom(room.scope, room.descriptor.id))?.membership?.members).toHaveLength(10)
  })

  it('atomically preserves the limit when multiple creator tabs race for the final slots', async () => {
    const { room, owner } = await host()
    await admitMember(room, owner)
    const users = await Promise.all(Array.from({ length: 12 }, member))
    const tabs = await Promise.all(users.map(() => loadRoom(room.scope, room.descriptor.id)))
    const results = await Promise.allSettled(users.map((user, index) => admitMember(tabs[index]!, owner, user.key, user.owner)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(9)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(3)
    const stored = (await loadRoom(room.scope, room.descriptor.id))!
    expect((await verifyMembership(stored, stored.membership, owner)).members).toHaveLength(10)
  })

  it('prevents duplicate-account devices and browser-key account substitution', async () => {
    const { room, owner } = await host()
    const user = await member(), other = await member()
    await admitMember(room, owner, user.key, user.owner)
    await expect(admitMember(room, owner, other.key, user.owner)).rejects.toMatchObject({ code: 'account-already-joined' })
    await expect(admitMember(room, owner, user.key, other.owner)).rejects.toThrow('different Pubky identity')
    await expect(admitMember(room, owner, other.key, owner)).rejects.toMatchObject({ code: 'account-already-joined' })
  })

  it('rejects forged, cross-document, and extra-field rosters even for invitation holders', async () => {
    const { room, owner } = await host(), attacker = await member()
    const roster = await admitMember(room, owner)
    await expect(verifyMembership(room, { ...roster, members: [{ key: room.hostKey, owner: attacker.owner }] }, attacker.owner)).rejects.toThrow()
    await expect(verifyMembership(room, { ...roster, room: encodeBytes(crypto.getRandomValues(new Uint8Array(24))) }, owner)).rejects.toThrow()
    await expect(verifyMembership(room, { ...roster, descriptor: { ...roster.descriptor, lineage: `shared:${crypto.randomUUID()}` } }, owner)).rejects.toThrow()
    await expect(verifyMembership(room, { ...roster, ignored: true }, owner)).rejects.toThrow()
    await expect(verifyMembership(room, roster, attacker.owner)).rejects.toThrow()
    const guest = await createGuestRoom(`guest:${crypto.randomUUID()}`, invitation(room))
    await expect(admitMember(guest, owner, attacker.key, attacker.owner)).rejects.toThrow('Invalid collaborator admission')
  })

  it('persists verified extensions and refuses rollback after reload or concurrent stale updates', async () => {
    const { room, owner } = await host(), user = await member()
    const first = await admitMember(room, owner)
    const guest = await createGuestRoom(`guest:${crypto.randomUUID()}`, invitation(room))
    await learnMembership(guest, first, owner)
    const second = await admitMember(room, owner, user.key, user.owner)
    await learnMembership(guest, second, owner)
    const reloaded = (await loadRoom(guest.scope, guest.descriptor.id))!
    expect((await learnMembership(reloaded, first, owner)).members).toHaveLength(2)
    expect(reloaded.hostIdentity).toBe(owner)
    await Promise.all([learnMembership(guest, first, owner), learnMembership(reloaded, second, owner)])
    expect((await loadRoom(guest.scope, guest.descriptor.id))?.membership?.members).toHaveLength(2)
  })

  it('rejects conflicting membership even when the pinned creator signed both branches', async () => {
    const { room, owner } = await host(), alice = await member(), bob = await member()
    const roster = await admitMember(room, owner, alice.key, alice.owner)
    const guest = await createGuestRoom(`guest:${crypto.randomUUID()}`, invitation(room))
    await learnMembership(guest, roster, owner)
    const { signature: _, ...body } = { ...roster, members: [{ key: room.hostKey, owner }, bob] }
    const signature = encodeBytes(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, room.identity.privateKey, new TextEncoder().encode(JSON.stringify(body)))))
    const conflicting: SignedMembership = { ...body, signature }
    await expect(learnMembership(guest, conflicting, owner)).rejects.toThrow('conflicting')
    expect(guest.membership?.members[1]).toEqual(alice)
  })
})
