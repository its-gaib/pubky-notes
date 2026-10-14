import type { Address } from '@synonymdev/pubky'
import { getPubky } from './pubky'

export interface Profile { name: string; image?: string }
export const MAX_PROFILE_BYTES = 16 * 1024
export const MAX_AVATAR_BYTES = 4 * 1024 * 1024
const RESOURCE_TIMEOUT = 10_000
const OWNER = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'])

// Profiles are public resources; loading them never uses the notes session.
export async function loadProfile(owner: string, signal?: AbortSignal): Promise<Profile> {
  if (!OWNER.test(owner)) throw new Error('Invalid Pubky identifier.')
  return withDeadline(signal, async (requestSignal) => {
    const response = await getResource(`pubky${owner}/pub/pubky.app/profile.json`, requestSignal)
    const value = await readJson(response, requestSignal)
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if ([...name].length < 3 || [...name].length > 50 || name === '[DELETED]') throw new Error('Invalid profile name.')
    // An invalid optional image must not hide an otherwise usable name.
    const image = typeof value.image === 'string' && value.image.length <= 300 ? value.image : undefined
    return { name, image }
  })
}

export async function loadAvatar(reference: string, signal?: AbortSignal): Promise<Blob> {
  return withDeadline(signal, async (requestSignal) => {
    let resource = parseResource(reference)
    let expectedType: string | undefined
    let expectedSize: number | undefined
    let response = await getResource(resource.address, requestSignal)
    // Pubky.app profile images commonly point to a file record, then its blob.
    if (resource.fileRecord) {
      const file = await readJson(response, requestSignal)
      expectedType = typeof file.content_type === 'string' ? file.content_type.toLowerCase().trim() : ''
      if (!IMAGE_TYPES.has(expectedType) || !Number.isSafeInteger(file.size) || Number(file.size) < 1 || Number(file.size) > MAX_AVATAR_BYTES) {
        throw new Error('Invalid avatar metadata.')
      }
      expectedSize = Number(file.size)
      if (typeof file.src !== 'string') throw new Error('Missing avatar resource.')
      resource = parseResource(file.src)
      if (resource.fileRecord) throw new Error('Nested avatar metadata is unsupported.')
      response = await getResource(resource.address, requestSignal)
    }
    const headerType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    const type = expectedType ?? headerType ?? ''
    if (!IMAGE_TYPES.has(type) || (headerType && headerType !== type && headerType !== 'application/octet-stream')) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error('Unsupported avatar image type.')
    }
    const bytes = await readBytes(response, MAX_AVATAR_BYTES, requestSignal)
    if ((expectedSize !== undefined && bytes.length !== expectedSize) || !matchesImageType(bytes, type)) {
      throw new Error('Avatar bytes do not match its image type or size.')
    }
    return new Blob([bytes], { type })
  })
}

function parseResource(value: string): { address: string; fileRecord: boolean } {
  if (!value || value.length > 1024 || /[\s\\]/u.test(value)) throw new Error('Invalid avatar resource.')
  const pubky = /^(?:pubky:\/\/|pubky)([ybndrfg8ejkmcpqxot1uwisza345h769]{52})(\/pub\/(?:[a-zA-Z0-9._~-]+\/)*[a-zA-Z0-9._~-]+)$/.exec(value)
  if (pubky) {
    const path = pubky[2]
    if (path.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Invalid avatar path.')
    return { address: `pubky${pubky[1]}${path}`, fileRecord: path.startsWith('/pub/pubky.app/files/') }
  }
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Unsupported avatar URL.')
  return { address: url.href, fileRecord: false }
}

async function getResource(address: string, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted()
  const request = address.startsWith('pubky')
    ? getPubky().publicStorage.get(address as Address)
    : fetch(address, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' })
  // The SDK does not take an AbortSignal. Discard a late response after timeout/unmount.
  void request.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined) }, () => undefined)
  const response = await abortable(request, signal)
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error(`Profile resource unavailable (${response.status}).`)
  }
  return response
}

async function readJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const bytes = await readBytes(response, MAX_PROFILE_BYTES, signal)
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid profile metadata.')
  return value as Record<string, unknown>
}

async function readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error('Profile resource is too large.')
  }
  if (!response.body) throw new Error('Empty profile resource.')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    signal.throwIfAborted()
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error('Profile resource is too large.')
      chunks.push(value)
    }
  } catch (error) {
    cancel()
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function matchesImageType(bytes: Uint8Array, type: string): boolean {
  const prefix = (...expected: number[]) => expected.every((value, index) => bytes[index] === value)
  if (type === 'image/png') return prefix(137, 80, 78, 71, 13, 10, 26, 10)
  if (type === 'image/jpeg') return prefix(255, 216, 255)
  if (type === 'image/gif') return prefix(71, 73, 70, 56) && [55, 57].includes(bytes[4]) && bytes[5] === 97
  if (type === 'image/webp') return prefix(82, 73, 70, 70) && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  if (type === 'image/avif' && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') {
    const boxLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
    for (let offset = 8; offset + 4 <= Math.min(boxLength, bytes.length, 128); offset += 4) {
      if (['avif', 'avis'].includes(String.fromCharCode(...bytes.subarray(offset, offset + 4)))) return true
    }
  }
  return false
}

async function withDeadline<T>(parent: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort(parent?.reason)
  if (parent?.aborted) cancel()
  else parent?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('Profile request timed out.', 'TimeoutError')), RESOURCE_TIMEOUT)
  try { return await work(controller.signal) }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', cancel) }
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let cancel!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  try { return await Promise.race([work, aborted]) }
  finally { signal.removeEventListener('abort', cancel) }
}
