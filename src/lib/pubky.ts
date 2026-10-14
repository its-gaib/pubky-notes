import { AuthFlowKind, Pubky } from '@synonymdev/pubky'
import type { GrantAuthFlow, Session } from '@synonymdev/pubky'
import { APP_CAPABILITIES, APP_CLIENT_ID, APP_PATHS, HTTP_RELAY, IS_TESTNET, TESTNET_HOST } from '../config'

const SESSION_KEY = `${APP_CLIENT_ID}:${IS_TESTNET ? 'testnet' : 'mainnet'}:session`
let instance: Pubky | undefined
const sessionRecords = new WeakMap<Session, string>()
let persistenceGeneration = 0

export interface AuthFlow {
  authorizationUrl: string
  awaitApproval: Promise<Session>
  cancel: () => void
}

// Keep transport construction out of module evaluation (including build tooling).
export function getPubky(): Pubky {
  instance ??= IS_TESTNET ? Pubky.testnet(TESTNET_HOST) : new Pubky()
  return instance
}

export async function startSignIn(): Promise<AuthFlow> {
  const flow = await getPubky().startGrantAuthFlow(APP_CAPABILITIES, AuthFlowKind.signin(), {
    clientId: APP_CLIENT_ID,
    relay: HTTP_RELAY,
  })
  return watchApproval(flow)
}

function watchApproval(flow: GrantAuthFlow): AuthFlow {
  let canceled = false
  let freed = false
  const cancel = () => {
    canceled = true
    if (freed) return
    freed = true
    try { flow.free() } catch { /* The WASM handle may already be consumed. */ }
  }
  const awaitApproval = (async () => {
    try {
      const session = await flow.awaitApproval()
      if (canceled) {
        await session.signout().catch(() => undefined)
        throw canceledError()
      }
      try {
        requireAppCapabilities(session)
      } catch (error) {
        await session.signout().catch(() => undefined)
        throw error
      }
      return session
    } catch (error) {
      if (canceled) throw canceledError()
      throw error
    } finally {
      if (!freed) {
        freed = true
        try { flow.free() } catch { /* The approval may consume the handle. */ }
      }
    }
  })()
  // The UI attaches its handler after displaying the authorization link.
  void awaitApproval.catch(() => undefined)
  return { authorizationUrl: flow.authorizationUrl, awaitApproval, cancel }
}

export async function persistSession(session: Session): Promise<string> {
  requireAppCapabilities(session)
  const generation = ++persistenceGeneration
  const stored = await getPubky().browserSessionStore.save(session)
  sessionRecords.set(session, stored.id)
  // Only the opaque record ID belongs here. Credentials stay in the SDK store.
  // A slower, older flow must not replace the pointer saved by a newer flow.
  if (generation === persistenceGeneration) {
    try {
      localStorage.setItem(SESSION_KEY, stored.id)
    } catch (error) {
      await discardSession(session, stored.id).catch(() => undefined)
      throw error
    }
  }
  return stored.id
}

export async function restoreSession(): Promise<Session | null> {
  const savedId = localStorage.getItem(SESSION_KEY)
  if (!savedId) return null
  try {
    const session = await getPubky().browserSessionStore.restore(savedId)
    requireAppCapabilities(session)
    sessionRecords.set(session, savedId)
    return session
  } catch (error) {
    if (isInvalidSession(error)) {
      await forgetSession(savedId)
      return null
    }
    // A temporary network outage must not destroy a restorable session.
    throw error
  }
}

export async function signOut(session: Session): Promise<void> {
  const savedId = sessionRecords.get(session) ?? localStorage.getItem(SESSION_KEY)
  // Keep the usable local session when server-side revocation fails.
  await session.signout()
  await forgetSession(savedId)
  sessionRecords.delete(session)
}

export async function discardSession(session: Session, savedId?: string): Promise<void> {
  const targetId = savedId ?? sessionRecords.get(session)
  const revocation = (async () => { await session.signout() })()
  // Handle rejection immediately while independent local cleanup runs.
  void revocation.catch(() => undefined)
  // Remove candidate credentials promptly even if network revocation hangs.
  // Candidate cleanup must never remove an unrelated flow's session pointer.
  const removal = forgetSession(targetId ?? null).then(() => { sessionRecords.delete(session) })
  await Promise.all([removal, revocation])
}

async function forgetSession(savedId: string | null): Promise<void> {
  if (!savedId) return
  try {
    if (localStorage.getItem(SESSION_KEY) === savedId) localStorage.removeItem(SESSION_KEY)
  } finally {
    await getPubky().browserSessionStore.remove(savedId)
  }
}

function requireAppCapabilities(session: Session): void {
  const capabilities = session.info.capabilities
  const allowed = Object.values(APP_PATHS).every((path) =>
    ['r', 'w'].every((action) => capabilities.some((capability) => {
      const separator = capability.lastIndexOf(':')
      const scope = capability.slice(0, separator)
      const actions = capability.slice(separator + 1)
      return separator > 0 && scope.endsWith('/') && path.startsWith(scope) && actions.includes(action)
    })),
  )
  if (!allowed) {
    const error = new Error('Authorize read and write access to both Notes folders to continue.')
    error.name = 'NotesPermissionError'
    throw error
  }
}

function isInvalidSession(error: unknown): boolean {
  return error instanceof Error &&
    ['AuthenticationError', 'InvalidInput', 'ClientStateError', 'NotesPermissionError'].includes(error.name)
}

function canceledError(): Error {
  const error = new Error('Sign-in canceled.')
  error.name = 'AuthCanceled'
  return error
}
