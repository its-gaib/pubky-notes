import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentityProof, IDENTITY_FAILED_MESSAGE, IDENTITY_UNAVAILABLE_MESSAGE, PROOF_MAX_AGE_MS, verifyIdentityProof } from './identity'
import type { IdentityContext } from './identity'
import { testIdentity } from './identity.test-helpers'

const context = (): IdentityContext => ({ room: 'test-room', descriptor: { id: 'note', createdAt: '2026-10-15T00:00:00Z', lineage: 'shared:test' },
  role: 'guest', publicKey: 'guest-browser-key', peerKey: 'host-browser-key', session: 'guest-session', peerSession: 'host-session', challenge: 'verifier-nonce' })
beforeEach(() => vi.stubGlobal('location', new URL('https://notes.example')))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('root-signed Pubky collaboration identity', () => {
  it('verifies the real SDK identity chain and returns only the authenticated root and expiry', async () => {
    const identity = testIdentity()
    const { proof, verified } = await createIdentityProof(identity, context())
    expect(verified.owner).toBe(identity.owner)
    expect(verified.expiresAt).toBeGreaterThan(Date.now())
    expect(Object.keys(proof).sort()).toEqual(['grant', 'pop'])
    expect(verifyIdentityProof(proof, context(), identity.owner)).toEqual(verified)
  })

  it('binds every room, role, browser, session and challenge field', async () => {
    const identity = testIdentity(), expected = context()
    const { proof } = await createIdentityProof(identity, expected)
    for (const key of ['room', 'publicKey', 'peerKey', 'session', 'peerSession', 'challenge'] as const) {
      expect(() => verifyIdentityProof(proof, { ...expected, [key]: 'different' })).toThrow(IDENTITY_FAILED_MESSAGE)
    }
    expect(() => verifyIdentityProof(proof, { ...expected, role: 'host' })).toThrow()
    for (const key of ['id', 'createdAt', 'lineage'] as const) {
      expect(() => verifyIdentityProof(proof, { ...expected, descriptor: { ...expected.descriptor, [key]: 'different' } })).toThrow()
    }
    expect(() => verifyIdentityProof(proof, expected, testIdentity().owner)).toThrow()
  })

  it('rejects copied grant with another signer, altered proof, extra fields, and oversized input', async () => {
    const first = await createIdentityProof(testIdentity(), context())
    const other = await createIdentityProof(testIdentity(), context())
    for (const proof of [null, { ...first.proof, pop: other.proof.pop }, { ...first.proof, secret: 'unwanted' },
      { ...first.proof, grant: 'x'.repeat(4097) }, { ...first.proof, pop: 'x'.repeat(8193) },
      { ...first.proof, pop: first.proof.pop.slice(0, -3) + 'aaa' }]) {
      expect(() => verifyIdentityProof(proof, context())).toThrow(IDENTITY_FAILED_MESSAGE)
    }
  })

  it('requires the expected app grant and matching local identity when creating proof', async () => {
    await expect(createIdentityProof(testIdentity('other-app'), context())).rejects.toThrow()
    const signer = testIdentity()
    await expect(createIdentityProof({ ...signer, owner: testIdentity().owner }, context())).rejects.toThrow()
  })

  it('binds origin, network and purpose and hides any local provider error details', async () => {
    const identity = testIdentity()
    for (const key of ['origin', 'network', 'purpose']) {
      const wrongContext = { ...identity, createProof: (data: Parameters<typeof identity.createProof>[0]) => identity.createProof({ ...data as object, [key]: 'different' }) }
      await expect(createIdentityProof(wrongContext, context())).rejects.toThrow(IDENTITY_UNAVAILABLE_MESSAGE)
    }
    const unavailable = { ...identity, createProof: async () => { throw new Error('private authentication context') } }
    await expect(createIdentityProof(unavailable, context())).rejects.toThrow(IDENTITY_UNAVAILABLE_MESSAGE)
  })

  it('rejects stale proofs and expired grants even if signatures remain valid', async () => {
    const now = Date.now()
    const { proof } = await createIdentityProof(testIdentity(), context())
    vi.spyOn(Date, 'now').mockReturnValue(now + PROOF_MAX_AGE_MS + 1000)
    expect(() => verifyIdentityProof(proof, context())).toThrow()
    vi.mocked(Date.now).mockReturnValue(now + 3_601_000)
    expect(() => verifyIdentityProof(proof, context())).toThrow()
  })
})
