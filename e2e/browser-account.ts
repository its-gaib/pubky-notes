import { Keypair, PublicKey } from '@synonymdev/pubky'
import type { Path, Session } from '@synonymdev/pubky'
import { getPubky, persistSession } from '../src/lib/pubky'
import { listNotes } from '../src/lib/notes'

const ACCOUNT = 'pubky-notes:e2e:disposable-account'
const CLEANUP = 'pubky-notes:e2e:cleanup-session'
const APP_SESSION = 'pubky-notes:e2e:app-session'
const HOMESERVER = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'

function requireLocalTestnet() {
  if (import.meta.env.VITE_PUBKY_TESTNET !== 'true' || import.meta.env.VITE_PUBKY_TESTNET_HOST !== '127.0.0.1'
    || window.location.hostname !== '127.0.0.1') throw new Error('E2E accounts require the explicit loopback-only Pubky testnet.')
}

/** Called only from an empty fixture page, never from the production bundle. */
export async function createAccount(): Promise<string> {
  requireLocalTestnet()
  if (localStorage.getItem(ACCOUNT)) throw new Error('Refusing to reuse a test account.')
  const pubky = getPubky(), keys = Keypair.random(), server = PublicKey.from(HOMESERVER)
  const signer = pubky.signer(keys)
  try {
    await signer.signup(server)
    const cleanup = await signer.signin(`notes-e2e-cleanup-${crypto.randomUUID()}`)
    try {
      localStorage.setItem(ACCOUNT, cleanup.info.publicKey.z32())
      localStorage.setItem(CLEANUP, (await pubky.browserSessionStore.save(cleanup)).id)
    } finally { cleanup.free() }
    const session = await signer.signin(`notes-e2e-app-${crypto.randomUUID()}`)
    try { localStorage.setItem(APP_SESSION, await persistSession(session)) }
    finally { session.free() }
    return localStorage.getItem(ACCOUNT)!
  } finally { signer.free(); keys.free(); server.free() }
}

async function cleanupSession(): Promise<Session> {
  requireLocalTestnet()
  const saved = localStorage.getItem(CLEANUP), owner = localStorage.getItem(ACCOUNT)
  if (!saved || !owner) throw new Error('No disposable test account is registered.')
  const session = await getPubky().browserSessionStore.restore(saved)
  if (session.info.publicKey.z32() !== owner) { session.free(); throw new Error('Test account identity changed.') }
  return session
}

/** Read actual homeserver files through an independent authenticated SDK session. */
export async function readNotes() {
  const session = await cleanupSession()
  try { return await listNotes(session) } finally { session.free() }
}

function missing(error: unknown) {
  return !!error && typeof error === 'object' && 'data' in error
    && [404, 410].includes((error.data as { statusCode?: number })?.statusCode ?? 0)
}

async function removeStored(id: string) {
  const store = getPubky().browserSessionStore
  if ((await store.list()).some(record => record.id === id)) await store.remove(id)
}

async function removeTestFile(session: Session, path: Path) {
  for (let attempt = 0; ; attempt++) {
    try { await session.storage.delete(path); return }
    catch (error) {
      const locked = !!error && typeof error === 'object' && 'data' in error
        && (error.data as { statusCode?: number })?.statusCode === 423
      // A final in-flight save can briefly lock the file after the page unloads.
      if (!locked || attempt >= 4) throw error
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

/** The context owns a freshly generated account; no user session is read or touched. */
export async function cleanAccount(): Promise<void> {
  requireLocalTestnet()
  if (!localStorage.getItem(ACCOUNT)) return
  const session = await cleanupSession(), pubky = getPubky()
  const failures: unknown[] = []
  try {
    for (const directory of ['/priv/notes/', '/pub/notes/'] as const) {
      let entries: string[]
      try { entries = await session.storage.list(directory, undefined, false, 100, false) }
      catch (error) { if (missing(error)) continue; throw error }
      if (entries.length >= 100) throw new Error('Unexpectedly large disposable account; refusing unbounded cleanup.')
      for (const entry of entries) {
        const path = new URL(entry).pathname as Path
        if (!path.startsWith(directory) || path.endsWith('/')) throw new Error('Unexpected test account file path.')
        await removeTestFile(session, path)
        if (await session.storage.exists(path)) throw new Error('Generated test file survived cleanup.')
      }
    }
  } catch (error) { failures.push(error) }
  finally {
    const appRecord = localStorage.getItem(APP_SESSION)
    if (appRecord && (await pubky.browserSessionStore.list()).some(record => record.id === appRecord)) {
      try {
        const appSession = await pubky.browserSessionStore.restore(appRecord)
        try { await appSession.signout() } finally { appSession.free() }
      } catch (error) {
        // The logout test deliberately revokes and removes this grant first.
        if (!(error instanceof Error) || !['AuthenticationError', 'InvalidInput', 'ClientStateError'].includes(error.name)) failures.push(error)
      }
      await removeStored(appRecord)
    }
    try { await session.signout() } catch (error) { failures.push(error) }
    finally { session.free() }
    await removeStored(localStorage.getItem(CLEANUP)!)
    localStorage.clear()
  }
  if (failures.length) throw new AggregateError(failures, 'Disposable account cleanup failed.')
}
