import { createPrivateKey, sign } from 'node:crypto'
import { Keypair } from '@synonymdev/pubky'
import type { JsonValue } from '@synonymdev/pubky'
import type { CollaborationIdentity } from './types'

/** Ephemeral test keys only; no account, storage, or network access. */
export function testIdentity(clientId = 'pubky-notes', expiresAt?: number): CollaborationIdentity {
  const root = Keypair.random(), delegate = Keypair.random()
  const owner = root.publicKey.z32(), cnf = delegate.publicKey.z32()
  const key = (pair: Keypair) => createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(pair.secret())]),
    format: 'der', type: 'pkcs8',
  })
  const rootKey = key(root), delegateKey = key(delegate)
  root.free(); delegate.free()
  const jws = (signer: typeof rootKey, typ: string, data: unknown) => {
    const encoded = [{ alg: 'EdDSA', typ }, data].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
    return `${encoded}.${sign(null, Buffer.from(encoded), signer).toString('base64url')}`
  }
  return { owner, async createProof(data: JsonValue) {
    const now = Math.floor(Date.now() / 1000)
    const jti = 'local-test-grant'
    return {
      grant: jws(rootKey, 'pubky-grant', { iss: owner, cnf, client_id: clientId, caps: [], jti, iat: now - 1, exp: expiresAt ?? now + 3600 }),
      pop: jws(delegateKey, 'pubky-custom-pop-v1', { gid: jti, iat: now, nonce: crypto.randomUUID().replace(/-/g, '').slice(0, 22), data }),
    }
  } }
}
