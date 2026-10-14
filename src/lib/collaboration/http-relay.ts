import { encodeBytes, randomToken } from './credentials'
import { MAX_SIGNAL_BYTES } from './signaling'
import type { StoredRoom } from './types'

const CHUNK_BYTES = 1500
const MAX_CHUNKS = Math.ceil(MAX_SIGNAL_BYTES / CHUNK_BYTES)

export interface SignalingSocket {
  readyState: number
  bufferedAmount: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  send(message: string): void
  close(): void
}

/** Stable per-identity inboxes reveal neither the invitation secret nor document identity. */
export async function relayInboxId(room: string, publicKey: string): Promise<string> {
  return encodeBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`pubky-notes:signaling:v1:${room}:${publicKey}`))))
}

export async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > limit) throw new Error('Relay response exceeds the limit')
  if (!response.body) throw new Error('Empty relay response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.length
      if (length > limit) throw new Error('Relay response exceeds the limit')
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export interface RelayManifest { version: 1; transfer: string; parts: number; bytes: number }

export function parseRelayManifest(value: unknown): RelayManifest {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'bytes,parts,transfer,version') throw new Error('Invalid relay manifest')
  const manifest = value as RelayManifest
  if (manifest.version !== 1 || typeof manifest.transfer !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(manifest.transfer)
    || !Number.isInteger(manifest.parts) || manifest.parts < 1 || manifest.parts > MAX_CHUNKS
    || !Number.isInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_SIGNAL_BYTES
    || manifest.parts !== Math.ceil(manifest.bytes / CHUNK_BYTES)) throw new Error('Invalid relay manifest')
  return manifest
}

/**
 * Pubky's public HTTP relay is the SDK's default rendezvous service. Its 2 KiB
 * inbox limit requires small temporary chunks; only encrypted signaling crosses
 * this adapter. A receiver ACKs the manifest only after reading every chunk.
 * Per-recipient serialized sends avoid overwriting the relay's one-slot inbox.
 */
export class HttpRelaySocket implements SignalingSocket {
  readyState = 0
  bufferedAmount = 0
  onopen: SignalingSocket['onopen'] = null
  onmessage: SignalingSocket['onmessage'] = null
  onclose: SignalingSocket['onclose'] = null
  onerror: SignalingSocket['onerror'] = null
  private readonly abort = new AbortController()
  private readonly queues = new Map<string, Promise<void>>()
  private stopped = false
  private failed = false

  constructor(private readonly baseUrl: string, private readonly room: StoredRoom) {
    queueMicrotask(() => {
      if (this.stopped) return
      this.readyState = 1
      this.onopen?.(new Event('open'))
      void this.consume()
    })
  }

  /** Pubsub subscribe/ping are unnecessary: this adapter has exactly one inbox. */
  send(_message: string): void {}

  publish(message: string, recipient: string): Promise<void> {
    if (this.stopped || message.length < 1 || message.length > MAX_SIGNAL_BYTES || this.bufferedAmount + message.length > MAX_SIGNAL_BYTES * 4 || this.queues.size > 4) return Promise.reject(new Error('Relay signaling capacity exceeded'))
    this.bufferedAmount += message.length
    const previous = this.queues.get(recipient) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(() => this.produce(message, recipient))
    const settled = work.catch(() => {}).finally(() => {
      this.bufferedAmount -= message.length
      if (this.queues.get(recipient) === settled) this.queues.delete(recipient)
    })
    this.queues.set(recipient, settled)
    return work
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    this.readyState = 3
    this.abort.abort()
    this.onclose?.(new Event('close') as CloseEvent)
  }

  private url(id: string): string { return `${this.baseUrl.replace(/\/$/, '')}/${id}` }

  private async request(url: string, options: RequestInit, signal: AbortSignal): Promise<Response> {
    const response = await fetch(url, { ...options, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal })
    if (!response.ok && response.status !== 408) throw new Error('Collaboration rendezvous is unavailable')
    return response
  }

  private async produce(message: string, recipient: string): Promise<void> {
    if (this.stopped) throw new Error('Collaboration closed')
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)])
    const inbox = this.url(await relayInboxId(this.room.room, recipient))
    const transfer = randomToken(24)
    const parts = Math.ceil(message.length / CHUNK_BYTES)
    const uploaded: string[] = []
    try {
      for (let index = 0; index < parts; index++) {
        const url = this.url(`${transfer}-${index}`)
        await this.request(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: message.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES) }, signal)
        uploaded.push(url)
      }
      const manifest: RelayManifest = { version: 1, transfer, parts, bytes: message.length }
      await this.request(inbox, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(manifest) }, signal)
      const acknowledged = await this.request(`${inbox}/await`, {}, signal)
      if (!acknowledged.ok) throw new Error('Collaborator did not receive connection details; retrying')
    } finally {
      // The receiver also deletes chunks. Best effort cleanup covers aborted sends;
      // the relay TTL removes leftovers when a tab closes or loses connectivity.
      if (!this.stopped) await Promise.allSettled(uploaded.map(url => this.request(url, { method: 'DELETE' }, AbortSignal.timeout(3_000))))
    }
  }

  private async consume(): Promise<void> {
    const inbox = this.url(await relayInboxId(this.room.room, this.room.identity.publicKey))
    while (!this.stopped) {
      try {
        const response = await this.request(inbox, {}, AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]))
        if (response.status === 408) continue
        const manifest = parseRelayManifest(JSON.parse(await readBoundedBody(response, 2048)))
        const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)])
        let message = ''
        const chunks: string[] = []
        for (let index = 0; index < manifest.parts; index++) {
          const url = this.url(`${manifest.transfer}-${index}`)
          const chunk = await this.request(url, {}, signal)
          if (!chunk.ok) throw new Error('Connection details expired')
          const part = await readBoundedBody(chunk, CHUNK_BYTES)
          if (part.length !== Math.min(CHUNK_BYTES, manifest.bytes - index * CHUNK_BYTES)) throw new Error('Invalid relay chunk length')
          message += part
          chunks.push(url)
        }
        if (message.length !== manifest.bytes || this.stopped) throw new Error('Invalid relay message length')
        if (this.failed) { this.failed = false; this.onopen?.(new Event('open')) }
        this.onmessage?.({ data: message } as MessageEvent)
        await this.request(inbox, { method: 'DELETE' }, signal)
        await Promise.allSettled(chunks.map(url => this.request(url, { method: 'DELETE' }, signal)))
      } catch {
        if (this.stopped) return
        this.failed = true
        this.onerror?.(new Event('error'))
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, 1500)
          this.abort.signal.addEventListener('abort', done, { once: true })
        })
      }
    }
  }
}
