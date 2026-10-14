import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@synonymdev/pubky'
import { APP_CAPABILITIES, APP_CLIENT_ID, APP_PATHS, LEGACY_PATHS, IS_TESTNET } from '../config'

const mocks = vi.hoisted(() => ({ save: vi.fn(), restore: vi.fn(), remove: vi.fn() }))
vi.mock('@synonymdev/pubky', () => ({
  AuthFlowKind: { signin: () => ({}) },
  Pubky: class {
    browserSessionStore = mocks
    static testnet() { return new this() }
  },
}))

const SESSION_KEY = `${APP_CLIENT_ID}:${IS_TESTNET ? 'testnet' : 'mainnet'}:session`
const localValues = new Map<string, string>()
const localStorageMock = {
  getItem: vi.fn((key: string) => localValues.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { localValues.set(key, value) }),
  removeItem: vi.fn((key: string) => { localValues.delete(key) }),
}

function makeSession() {
  return {
    info: { capabilities: APP_CAPABILITIES.split(',') },
    signout: vi.fn(async () => undefined),
  } as unknown as Session
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.save.mockReset().mockResolvedValue({ id: 'saved-session' })
  mocks.restore.mockReset()
  mocks.remove.mockReset().mockResolvedValue(undefined)
  localValues.clear()
  localStorageMock.setItem.mockImplementation((key, value) => { localValues.set(key, value) })
  vi.stubGlobal('localStorage', localStorageMock)
})

describe('persisted grant lifecycle', () => {
  it('returns the exact saved ID and keeps only that opaque ID in localStorage', async () => {
    const { persistSession } = await import('./pubky')
    const session = makeSession()
    await expect(persistSession(session)).resolves.toBe('saved-session')
    expect(mocks.save).toHaveBeenCalledWith(session)
    expect([...localValues.entries()]).toEqual([[SESSION_KEY, 'saved-session']])
  })

  it('removes a canceled candidate even when revocation fails', async () => {
    const { persistSession, discardSession } = await import('./pubky')
    const session = makeSession()
    const savedId = await persistSession(session)
    vi.mocked(session.signout).mockRejectedValue(new Error('Offline'))
    await expect(discardSession(session, savedId)).rejects.toThrow('Offline')
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(savedId)
    expect(localValues.has(SESSION_KEY)).toBe(false)
  })

  it('removes candidate credentials before a delayed network revocation completes', async () => {
    const { persistSession, discardSession } = await import('./pubky')
    const session = makeSession()
    const savedId = await persistSession(session)
    let completeRevocation!: () => void
    vi.mocked(session.signout).mockImplementation(() => new Promise<void>(resolve => { completeRevocation = resolve }))
    const discarding = discardSession(session, savedId)
    expect(localValues.has(SESSION_KEY)).toBe(false)
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(savedId)
    await Promise.resolve()
    expect(mocks.remove.mock.settledResults[0].type).toBe('fulfilled')
    completeRevocation()
    await expect(discarding).resolves.toBeUndefined()
  })

  it('does not remove a newer flow’s pointer while discarding an older candidate', async () => {
    const { persistSession, discardSession } = await import('./pubky')
    const oldSession = makeSession()
    mocks.save.mockResolvedValueOnce({ id: 'older' }).mockResolvedValueOnce({ id: 'newer' })
    const oldId = await persistSession(oldSession)
    await persistSession(makeSession())
    await discardSession(oldSession, oldId)
    expect(localValues.get(SESSION_KEY)).toBe('newer')
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('older')
  })

  it('does not touch another session when an unsaved candidate is discarded', async () => {
    const { discardSession } = await import('./pubky')
    localValues.set(SESSION_KEY, 'unrelated')
    await discardSession(makeSession())
    expect(localValues.get(SESSION_KEY)).toBe('unrelated')
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('keeps the session locally if an explicit sign-out cannot revoke it', async () => {
    const { persistSession, signOut } = await import('./pubky')
    const session = makeSession()
    await persistSession(session)
    vi.mocked(session.signout).mockRejectedValue(new Error('Revocation failed'))
    await expect(signOut(session)).rejects.toThrow('Revocation failed')
    expect(localValues.get(SESSION_KEY)).toBe('saved-session')
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('removes the session after successful explicit revocation', async () => {
    const { persistSession, signOut } = await import('./pubky')
    const session = makeSession()
    await persistSession(session)
    await signOut(session)
    expect(localValues.has(SESSION_KEY)).toBe(false)
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('saved-session')
    expect(vi.mocked(session.signout).mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0])
  })

  it('cleans up an SDK record if writing its localStorage pointer fails', async () => {
    const { persistSession } = await import('./pubky')
    const session = makeSession()
    localStorageMock.setItem.mockImplementationOnce(() => { throw new Error('Storage blocked') })
    await expect(persistSession(session)).rejects.toThrow('Storage blocked')
    expect(session.signout).toHaveBeenCalledOnce()
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('saved-session')
  })

  it('prevents a slower older persistence operation from replacing the newer pointer', async () => {
    const { persistSession, discardSession } = await import('./pubky')
    let completeOlder!: (value: { id: string }) => void
    mocks.save.mockImplementationOnce(() => new Promise(resolve => { completeOlder = resolve }))
      .mockResolvedValueOnce({ id: 'newer' })
    const older = makeSession()
    const savingOlder = persistSession(older)
    await persistSession(makeSession())
    completeOlder({ id: 'older' })
    const oldId = await savingOlder
    expect(localValues.get(SESSION_KEY)).toBe('newer')
    await discardSession(older, oldId)
    expect(localValues.get(SESSION_KEY)).toBe('newer')
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('older')
  })

  it('keeps the saved record after temporary restore failures', async () => {
    const { restoreSession } = await import('./pubky')
    localValues.set(SESSION_KEY, 'saved-session')
    mocks.restore.mockRejectedValue(new Error('Offline'))
    await expect(restoreSession()).rejects.toThrow('Offline')
    expect(localValues.get(SESSION_KEY)).toBe('saved-session')
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})


describe('namespace authorization upgrade', () => {
  it('requests only the four exact new and legacy roots', () => {
    expect(APP_CAPABILITIES.split(',')).toEqual([
      '/priv/notes/:rw', '/pub/notes/:rw', '/priv/notes.pubky.app/notes/:rw', '/pub/notes.pubky.app/notes/:rw',
    ])
  })

  it('forgets an old-only saved grant and reports that sign-in is required', async () => {
    const { restoreSession } = await import('./pubky')
    const oldSession = makeSession()
    Object.assign(oldSession.info, { capabilities: Object.values(LEGACY_PATHS).map(path => `${path}:rw`) })
    localValues.set(SESSION_KEY, 'old-session')
    mocks.restore.mockResolvedValue(oldSession)
    await expect(restoreSession()).rejects.toMatchObject({ name: 'NotesPermissionError', message: expect.stringContaining('Sign in again') })
    expect(localValues.has(SESSION_KEY)).toBe(false)
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('old-session')
  })

  it('rejects a grant without legacy cleanup access before persisting it', async () => {
    const { persistSession } = await import('./pubky')
    const session = makeSession()
    Object.assign(session.info, { capabilities: Object.values(APP_PATHS).map(path => `${path}:rw`) })
    await expect(persistSession(session)).rejects.toMatchObject({ name: 'NotesPermissionError' })
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('restores upgraded grants with all required scopes', async () => {
    const { restoreSession } = await import('./pubky')
    const session = makeSession()
    localValues.set(SESSION_KEY, 'upgraded')
    mocks.restore.mockResolvedValue(session)
    await expect(restoreSession()).resolves.toBe(session)
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})
