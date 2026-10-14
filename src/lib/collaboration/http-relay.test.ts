import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGuestRoom, createHostRoom, randomToken } from './credentials'
import { HttpRelaySocket, parseRelayManifest, readBoundedBody, relayInboxId } from './http-relay'
import { openSignal, ReplayGuard, sealSignal } from './signaling'

/** Match http-relay's one-slot inbox, destructive overwrite, explicit ACK behavior. */
function fakeRelay() {
  const entries = new Map<string, { value: string | null; acknowledged: boolean }>()
  const readers = new Map<string, Set<() => void>>()
  const calls: { method: string; path: string; body: string }[] = []
  const notify = (path: string) => readers.get(path)?.forEach(reader => reader())
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname
    const method = init.method ?? 'GET'
    calls.push({ method, path, body: typeof init.body === 'string' ? init.body : '' })
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (method === 'POST') {
      const body = String(init.body)
      if (new TextEncoder().encode(body).length > 2048) return new Response('', { status: 413 })
      entries.set(path, { value: body, acknowledged: false })
      notify(path)
      return new Response('')
    }
    if (method === 'DELETE') {
      entries.set(path, { value: null, acknowledged: true })
      notify(`${path}/await`)
      return new Response('')
    }
    return new Promise<Response>((resolve, reject) => {
      const awaiting = path.endsWith('/await')
      const inbox = awaiting ? path.slice(0, -6) : path
      const cleanup = () => {
        clearTimeout(timeout)
        readers.get(path)?.delete(check)
        init.signal?.removeEventListener('abort', aborted)
      }
      const aborted = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')) }
      const check = () => {
        const entry = entries.get(inbox)
        if (awaiting ? entry?.acknowledged : entry?.value != null) {
          cleanup()
          resolve(new Response(awaiting ? 'true' : entry!.value))
        }
      }
      const timeout = setTimeout(() => { cleanup(); resolve(new Response('', { status: 408 })) }, 100)
      if (!readers.has(path)) readers.set(path, new Set())
      readers.get(path)!.add(check)
      init.signal?.addEventListener('abort', aborted, { once: true })
      check()
    })
  })
  return { fetch, calls, entries }
}

async function pair() {
  const host = await createHostRoom(`host:${crypto.randomUUID()}`, { id: crypto.randomUUID(), createdAt: '2026-10-14T12:00:00.000Z', lineage: `shared:${crypto.randomUUID()}` })
  const guest = await createGuestRoom(`guest:${crypto.randomUUID()}`, { version: 1, room: host.room, secret: host.secret, hostKey: host.hostKey, descriptor: host.descriptor })
  return { host, guest }
}

describe('HTTP relay rendezvous', () => {
  const sockets: HttpRelaySocket[] = []
  afterEach(() => { sockets.splice(0).forEach(socket => socket.close()); vi.unstubAllGlobals() })

  it('transfers an encrypted signed offer larger than the relay body limit and deletes temporary chunks', async () => {
    const { host, guest } = await pair()
    const relay = fakeRelay()
    vi.stubGlobal('fetch', relay.fetch)
    const sender = new HttpRelaySocket('https://relay.example/inbox', host)
    const receiver = new HttpRelaySocket('https://relay.example/inbox', guest)
    sockets.push(sender, receiver)
    const received = vi.fn()
    receiver.onmessage = event => received(event.data)
    const envelope = await sealSignal(host, { kind: 'offer', to: guest.identity.publicKey, session: randomToken(16), targetSession: randomToken(16), payload: 'v=0\r\n' + 'a'.repeat(8_000) })
    const packet = JSON.stringify({ type: 'publish', topic: host.room, data: envelope })
    await sender.publish(packet, guest.identity.publicKey)
    expect(received).toHaveBeenCalledExactlyOnceWith(packet)
    expect(await openSignal(JSON.parse(received.mock.calls[0][0]).data, guest, new ReplayGuard())).toMatchObject({ kind: 'offer' })
    expect(relay.calls.filter(call => call.method === 'POST').length).toBeGreaterThan(5)
    expect(relay.calls.filter(call => call.method === 'POST').every(call => call.body.length <= 2048)).toBe(true)
    expect(relay.calls.filter(call => call.method === 'POST').every(call => !call.body.includes(host.secret))).toBe(true)
    expect([...relay.entries.values()].every(entry => entry.value === null)).toBe(true)
  })

  it('serializes several outgoing messages without one-slot overwrite and supports simultaneous opposite-direction sends', async () => {
    const { host, guest } = await pair()
    const relay = fakeRelay()
    vi.stubGlobal('fetch', relay.fetch)
    const a = new HttpRelaySocket('https://relay.example/inbox', host)
    const b = new HttpRelaySocket('https://relay.example/inbox', guest)
    sockets.push(a, b)
    const aReceived: string[] = [], bReceived: string[] = []
    a.onmessage = event => aReceived.push(event.data)
    b.onmessage = event => bReceived.push(event.data)
    await Promise.all([
      a.publish('first'.repeat(1000), guest.identity.publicKey), a.publish('second', guest.identity.publicKey), a.publish('third', guest.identity.publicKey),
      b.publish('reverse direction', host.identity.publicKey),
    ])
    expect(bReceived).toEqual(['first'.repeat(1000), 'second', 'third'])
    expect(aReceived).toEqual(['reverse direction'])
    await vi.waitFor(() => expect(a.bufferedAmount).toBe(0))
  })

  it('derives distinct identity inboxes and rejects malformed, oversized, or unbounded manifests', async () => {
    const { host, guest } = await pair()
    const own = await relayInboxId(host.room, host.hostKey)
    expect(own).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(own).not.toBe(await relayInboxId(host.room, guest.identity.publicKey))
    const good = { version: 1, transfer: randomToken(24), parts: 2, bytes: 1600 }
    expect(parseRelayManifest(good)).toEqual(good)
    for (const bad of [null, {}, { ...good, transfer: '../other-inbox' }, { ...good, parts: 100_000 }, { ...good, bytes: 65_537 }, { ...good, parts: 1 }, { ...good, extra: true }]) {
      expect(() => parseRelayManifest(bad)).toThrow()
    }
  })

  it('bounds response bodies even without a Content-Length header', async () => {
    await expect(readBoundedBody(new Response('a'.repeat(2049)), 2048)).rejects.toThrow('limit')
    await expect(readBoundedBody(new Response('safe', { headers: { 'Content-Length': '1000000' } }), 2048)).rejects.toThrow('limit')
    expect(await readBoundedBody(new Response('safe'), 2048)).toBe('safe')
  })

  it('aborts pending inbox polling and sends on account disposal', async () => {
    const { host, guest } = await pair()
    vi.stubGlobal('fetch', fakeRelay().fetch)
    const socket = new HttpRelaySocket('https://relay.example/inbox', host)
    sockets.push(socket)
    const outgoing = socket.publish('connection details', guest.identity.publicKey)
    await Promise.resolve()
    socket.close()
    await expect(outgoing).rejects.toThrow()
    await expect(socket.publish('late', guest.identity.publicKey)).rejects.toThrow()
    expect(socket.readyState).toBe(3)
  })
})
