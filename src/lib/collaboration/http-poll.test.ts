import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollRelay } from './http-poll'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('fair HTTP/1.1 relay polling', () => {
  it('bounds idle reads to two per origin, rotates fairly, and removes cancelled waiters', async () => {
    const pending: { url: string; resolve(response: Response): void }[] = []
    const fetch = vi.fn((url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      const aborted = () => reject(new DOMException('Aborted', 'AbortError'))
      options.signal?.addEventListener('abort', aborted, { once: true })
      pending.push({ url, resolve: response => { options.signal?.removeEventListener('abort', aborted); resolve(response) } })
    }))
    vi.stubGlobal('fetch', fetch)
    const controls = Array.from({ length: 5 }, () => new AbortController())
    const reads = controls.map((controller, index) => pollRelay(`https://relay.example/${index}`, { signal: controller.signal }))
    const settled = Promise.allSettled(reads)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    controls[3].abort()
    pending.shift()!.resolve(new Response('first'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect(pending[1].url).toBe('https://relay.example/2')
    pending.shift()!.resolve(new Response('second'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
    expect(pending[1].url).toBe('https://relay.example/4')
    pending.splice(0).forEach(item => item.resolve(new Response('done')))
    expect((await settled).map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled'])
  })

  it('treats a slice timeout as an empty poll, never as an acknowledgement', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })))
    const read = pollRelay('https://relay.example/inbox/await', { signal: new AbortController().signal })
    await vi.advanceTimersByTimeAsync(1_001)
    expect((await read).status).toBe(408)
  })
})
