import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIceConfigurationCache } from './ice-cache'

const configuration = (expiresAt = Date.now() + 600_000) => ({
  iceServers: [{ urls: 'turn:relay.example:3478', username: 'temporary', credential: 'temporary' }],
  relayAvailable: true,
  expiresAt,
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('shared group TURN configuration', () => {
  it('shares one initial request across nine edges and refreshes once before expiry', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => ({ ok: true, json: async () => configuration() }))
    vi.stubGlobal('fetch', fetch)
    const cache = createIceConfigurationCache('/api/collaboration-ice')
    try {
      const initial = await Promise.all(Array.from({ length: 9 }, () => cache.get()))
      expect(fetch).toHaveBeenCalledOnce()
      expect(initial.every(value => value === initial[0])).toBe(true)
      await vi.advanceTimersByTimeAsync(479_000)
      expect(await cache.get()).toBe(initial[0])
      expect(fetch).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1_000)
      const refreshed = await Promise.all(Array.from({ length: 9 }, () => cache.get()))
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(refreshed[0].expiresAt).toBeGreaterThan(initial[0].expiresAt)
      expect(refreshed.every(value => value === refreshed[0])).toBe(true)
    } finally { cache.dispose() }
  })

  it('rejects a downgrade or stale credentials rather than replacing a working relay', async () => {
    vi.useFakeTimers()
    const first = configuration()
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => first })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...configuration(), iceServers: [], relayAvailable: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => first })
      .mockImplementation(async () => ({ ok: true, json: async () => configuration() }))
    vi.stubGlobal('fetch', fetch)
    const cache = createIceConfigurationCache()
    try {
      await cache.get()
      await vi.advanceTimersByTimeAsync(480_000)
      await expect(cache.get()).rejects.toThrow('unavailable')
      await expect(cache.get()).rejects.toThrow('unavailable')
      expect((await cache.get()).expiresAt).toBeGreaterThan(first.expiresAt)
    } finally { cache.dispose() }
  })

  it('cancels all waiting edges after the five-second request timeout and permits a retry', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn((_url: RequestInfo | URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    vi.stubGlobal('fetch', fetch)
    const cache = createIceConfigurationCache()
    try {
      const waiting = Promise.allSettled(Array.from({ length: 9 }, () => cache.get()))
      await vi.advanceTimersByTimeAsync(5_000)
      expect((await waiting).every(result => result.status === 'rejected')).toBe(true)
      expect(fetch).toHaveBeenCalledOnce()
      fetch.mockResolvedValue({ ok: true, json: async () => configuration() })
      expect((await cache.get()).relayAvailable).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { cache.dispose() }
  })

  it('does not retain credentials or accept a late response after room disposal', async () => {
    let release!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { release = resolve })))
    const cache = createIceConfigurationCache()
    const pending = cache.get()
    cache.dispose()
    release({ ok: true, json: async () => configuration() })
    await expect(pending).rejects.toThrow('cancelled')
    await expect(cache.get()).rejects.toThrow('cancelled')
  })

  it.each([
    { ...configuration(), expiresAt: NaN },
    { ...configuration(), expiresAt: Date.now() + 1_000 },
    { ...configuration(), iceServers: [{ urls: 'https://not-a-turn-service.example' }] },
  ])('rejects invalid configuration', async value => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => value })))
    const cache = createIceConfigurationCache()
    try { await expect(cache.get()).rejects.toThrow() } finally { cache.dispose() }
  })
})
