import { encodeBytes, randomToken } from './credentials'
import { readBoundedBody } from './http-relay'
import { openSignal, ReplayGuard, sealSignal } from './signaling'
import type { StoredRoom } from './types'
import { pollRelay } from './http-poll'

const DEFAULT_URL = import.meta.env.VITE_COLLAB_SIGNAL_URL || 'https://httprelay.pubky.app/inbox/'
const STRIPES = 4
const MAX_BYTES = 2048

export interface DiscoveryOptions {
  signalingUrl?: string
  onJoin?(key: string): void
  onError?(error: Error): void
}

/** Rendezvous is deliberately separate from the reliable, isolated pair inboxes. */
export async function discoveryInboxId(room: StoredRoom, stripe: number): Promise<string> {
  return encodeBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    `pubky-notes:group-discovery:v1:${room.room}:${room.hostKey}:${stripe}`,
  ))))
}

/**
 * Unknown guests may overwrite one another's announcements. Randomized retries
 * repair that loss; only an authenticated pair handshake confirms admission.
 * In particular, shared-inbox DELETE or /await is NEVER a delivery receipt.
 */
export function startDiscovery(room: StoredRoom, options: DiscoveryOptions = {}): { dispose(): void } {
  const abort = new AbortController()
  const replay = new ReplayGuard()
  const session = randomToken(16)
  let socket: WebSocket | undefined
  let queued = 0
  let incoming = Promise.resolve()
  let base: string
  try {
    const url = new URL(options.signalingUrl ?? DEFAULT_URL)
    if (!['https:', 'wss:'].includes(url.protocol)
      && !(['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error()
    if (url.username || url.password || url.hash) throw new Error()
    base = url.href.replace(/\/$/, '')
  } catch {
    queueMicrotask(() => { if (!abort.signal.aborted) options.onError?.(new Error('Invalid collaboration discovery URL')) })
    return { dispose: () => abort.abort() }
  }

  function delay(ms: number): Promise<void> {
    if (abort.signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, ms)
      abort.signal.addEventListener('abort', done, { once: true })
    })
  }

  async function announcement(): Promise<string> {
    const signal = await sealSignal(room, { to: room.hostKey, kind: 'hello', session, targetSession: '', payload: '' })
    const body = JSON.stringify({ discovery: 1, signal })
    if (body.length > MAX_BYTES) throw new Error('Collaboration discovery message is too large')
    return body
  }

  function receive(body: string) {
    if (room.role !== 'host' || abort.signal.aborted || body.length > MAX_BYTES || queued >= 16) return
    queued++
    incoming = incoming.then(async () => {
      if (abort.signal.aborted) return
      const envelope: unknown = JSON.parse(body)
      if (!envelope || typeof envelope !== 'object' || Object.keys(envelope).sort().join(',') !== 'discovery,signal') return
      const packet = envelope as { discovery: unknown; signal: unknown }
      if (packet.discovery !== 1) return
      const signal = await openSignal(packet.signal, room, replay)
      if (!abort.signal.aborted && signal?.kind === 'hello' && signal.payload === '') options.onJoin?.(signal.from)
    }).catch(() => { /* Invalid announcements never reserve a participant slot. */ }).finally(() => { queued-- })
  }

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const options: RequestInit & { signal: AbortSignal } = { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) }
    const response = await (!init.method ? pollRelay(url, options) : fetch(url, options))
    if (!response.ok && response.status !== 408) { await response.body?.cancel(); throw new Error('Discovery unavailable') }
    return response
  }

  async function watch(stripe: number) {
    const url = `${base}/${await discoveryInboxId(room, stripe)}`
    while (!abort.signal.aborted) {
      try {
        const response = await request(url)
        if (response.status === 408) continue
        const body = await readBoundedBody(response, MAX_BYTES)
        if (abort.signal.aborted) return
        // A concurrent overwrite can be deleted here. The sender repeats until
        // the independently authenticated pair connection admits it.
        await request(url, { method: 'DELETE' })
        receive(body)
        await delay(50)
      } catch { await delay(1_000 + Math.random() * 1_000) }
    }
  }

  async function announceHttp() {
    while (!abort.signal.aborted) {
      try {
        const stripe = Math.floor(Math.random() * STRIPES)
        const [id, body] = await Promise.all([discoveryInboxId(room, stripe), announcement()])
        if (abort.signal.aborted) return
        await request(`${base}/${id}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
      } catch { /* A fresh signed announcement is retried after backoff. */ }
      await delay(2_000 + Math.random() * 4_000)
    }
  }

  async function websocket() {
    while (!abort.signal.aborted) {
      await new Promise<void>(resolve => {
        let next: WebSocket
        try { next = new WebSocket(base) } catch { resolve(); return }
        socket = next
        let heartbeat: ReturnType<typeof setInterval> | undefined
        let announcing = false
        const sendAnnouncement = async () => {
          if (room.role !== 'guest' || announcing || next.readyState !== 1 || abort.signal.aborted) return
          announcing = true
          try {
            const body = await announcement()
            if (next === socket && next.readyState === 1 && !abort.signal.aborted) next.send(JSON.stringify({ type: 'publish', topic: room.room, data: JSON.parse(body) }))
          } catch { /* Reconnect/retry on the next tick. */ }
          finally { announcing = false }
        }
        next.onopen = () => {
          if (abort.signal.aborted) { next.close(); return }
          next.send(JSON.stringify({ type: 'subscribe', topics: [room.room] }))
          void sendAnnouncement()
          heartbeat = setInterval(() => {
            if (next.readyState !== 1 || abort.signal.aborted) return
            next.send(JSON.stringify({ type: 'ping' }))
            void sendAnnouncement()
          }, 4_000 + Math.random() * 1_000)
        }
        next.onmessage = event => {
          if (abort.signal.aborted || typeof event.data !== 'string' || event.data.length > MAX_BYTES + 128) return
          try {
            const packet = JSON.parse(event.data)
            if (packet?.type === 'publish' && packet.topic === room.room) receive(JSON.stringify(packet.data))
          } catch { /* Ignore unrelated or malformed publications. */ }
        }
        next.onerror = () => next.close()
        next.onclose = () => { clearInterval(heartbeat); if (socket === next) socket = undefined; resolve() }
      })
      await delay(1_000 + Math.random() * 1_000)
    }
  }

  if (base.startsWith('http')) {
    if (room.role === 'host') for (let stripe = 0; stripe < STRIPES; stripe++) void watch(stripe).catch(() => {})
    else void announceHttp()
  } else void websocket()
  return { dispose() { abort.abort(); socket?.close() } }
}
