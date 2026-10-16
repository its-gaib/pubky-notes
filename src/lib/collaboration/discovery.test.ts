import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGuestRoom, createHostRoom, randomToken } from './credentials'
import { discoveryInboxId, startDiscovery } from './discovery'
import { sealSignal } from './signaling'

const active: { dispose(): void }[] = []
afterEach(() => { active.splice(0).forEach(item => item.dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function rooms() {
  const host = await createHostRoom(`host:${crypto.randomUUID()}`, { id: crypto.randomUUID(), createdAt: '2026-10-16T10:00:00Z', lineage: `shared:${crypto.randomUUID()}` })
  const invitation = { version: 1 as const, room: host.room, secret: host.secret, hostKey: host.hostKey, descriptor: host.descriptor }
  const guests = await Promise.all([1, 2, 3].map(() => createGuestRoom(`guest:${crypto.randomUUID()}`, invitation)))
  return { host, guests }
}

/** Deliberately lossy single-value relay, including its overwrite/delete race. */
function relay(dropFirst = false) {
  const inboxes = new Map<string, string>()
  const listeners = new Map<string, Set<() => void>>()
  const posts: string[] = [], paths: string[] = []
  let dropped = false
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (init.method === 'POST') {
      posts.push(String(init.body))
      if (dropFirst && !dropped) { dropped = true; return new Response('') }
      inboxes.set(path, String(init.body))
      listeners.get(path)?.forEach(notify => notify())
      return new Response('')
    }
    if (init.method === 'DELETE') { inboxes.delete(path); return new Response('') }
    return new Promise<Response>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); listeners.get(path)?.delete(check); init.signal?.removeEventListener('abort', aborted) }
      const check = () => { const value = inboxes.get(path); if (value) { cleanup(); resolve(new Response(value)) } }
      const aborted = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')) }
      const timer = setTimeout(() => { cleanup(); resolve(new Response('', { status: 408 })) }, 200)
      if (!listeners.has(path)) listeners.set(path, new Set())
      listeners.get(path)!.add(check)
      init.signal?.addEventListener('abort', aborted, { once: true })
      check()
    })
  })
  return { fetch, inboxes, posts, paths }
}

describe('group discovery', () => {
  it('retries a lost introduction without treating a relay ACK as admission', async () => {
    const { host, guests } = await rooms()
    const network = relay(true), joined = vi.fn()
    vi.stubGlobal('fetch', network.fetch)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    active.push(startDiscovery(host, { signalingUrl: 'https://relay.example/inbox', onJoin: joined }))
    active.push(startDiscovery(guests[0], { signalingUrl: 'https://relay.example/inbox' }))
    await vi.waitFor(() => expect(joined).toHaveBeenCalledWith(guests[0].identity.publicKey), { timeout: 5_000 })
    expect(network.posts.length).toBeGreaterThanOrEqual(2)
    expect(network.posts.every(body => body.length <= 2048 && !body.includes(host.secret))).toBe(true)
    expect(network.paths.some(path => path.endsWith('/await'))).toBe(false)
  }, 8_000)

  it('discovers simultaneous guests despite initial overwrite, and aborts all watchers on disposal', async () => {
    const { host, guests } = await rooms()
    const network = relay(), seen = new Set<string>()
    vi.stubGlobal('fetch', network.fetch)
    active.push(startDiscovery(host, { signalingUrl: 'https://relay.example/inbox', onJoin: key => seen.add(key) }))
    for (const guest of guests) active.push(startDiscovery(guest, { signalingUrl: 'https://relay.example/inbox' }))
    await vi.waitFor(() => expect(seen.size).toBe(3), { timeout: 12_000 })
    active.splice(0).forEach(item => item.dispose())
    await new Promise(resolve => setTimeout(resolve, 20))
    const count = network.fetch.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(network.fetch).toHaveBeenCalledTimes(count)
  }, 15_000)

  it('does not allocate peers for unsigned, cross-room, oversized or replayed announcements', async () => {
    const { host, guests } = await rooms()
    const network = relay(), joined = vi.fn()
    vi.stubGlobal('fetch', network.fetch)
    const url = `https://relay.example/inbox/${await discoveryInboxId(host, 0)}`
    active.push(startDiscovery(host, { signalingUrl: 'https://relay.example/inbox', onJoin: joined }))
    const post = (body: string) => network.fetch(url, { method: 'POST', body })
    await post(JSON.stringify({ discovery: 1, signal: { from: guests[0].identity.publicKey } }))
    await new Promise(resolve => setTimeout(resolve, 80))
    const fields = { to: host.hostKey, kind: 'hello' as const, session: randomToken(16), targetSession: '', payload: '' }
    const wrong = await sealSignal({ ...guests[0], room: randomToken(24) }, fields)
    await post(JSON.stringify({ discovery: 1, signal: wrong }))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(joined).not.toHaveBeenCalled()
    const valid = JSON.stringify({ discovery: 1, signal: await sealSignal(guests[0], fields) })
    await post(valid)
    await vi.waitFor(() => expect(joined).toHaveBeenCalledTimes(1))
    await post(valid)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(joined).toHaveBeenCalledTimes(1)
    await post('x'.repeat(2049))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(joined).toHaveBeenCalledTimes(1)
  })

  it('separates room stripes and rejects insecure or credential-bearing discovery services', async () => {
    const { host } = await rooms()
    expect(await discoveryInboxId(host, 0)).not.toBe(await discoveryInboxId(host, 1))
    const fetch = vi.fn(), error = vi.fn()
    vi.stubGlobal('fetch', fetch)
    active.push(startDiscovery(host, { signalingUrl: 'http://relay.example/inbox', onError: error }))
    active.push(startDiscovery(host, { signalingUrl: 'https://user:password@relay.example/inbox', onError: error }))
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(2)
  })
})
