/**
 * The public relay currently serves HTTP/1.1. Browsers commonly allow only six
 * requests per origin, so nine idle inbox reads could otherwise block every
 * outgoing offer/answer. Reserve at most two slots for long polls and rotate
 * them fairly; ordinary uploads, chunk reads and deletes remain free to run.
 */
const origins = new Map<string, { active: number; waiting: (() => void)[] }>()
const SLICE_MS = 1_000

async function acquire(origin: string, signal: AbortSignal): Promise<() => void> {
  let pool = origins.get(origin)
  if (!pool) { pool = { active: 0, waiting: [] }; origins.set(origin, pool) }
  const selected = pool
  return new Promise((resolve, reject) => {
    const aborted = () => {
      const index = selected.waiting.indexOf(start)
      if (index !== -1) selected.waiting.splice(index, 1)
      signal.removeEventListener('abort', aborted)
      if (!selected.active && !selected.waiting.length) origins.delete(origin)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const start = () => {
      signal.removeEventListener('abort', aborted)
      if (signal.aborted) { aborted(); return }
      selected.active++
      resolve(() => {
        selected.active--
        selected.waiting.shift()?.()
        if (!selected.active && !selected.waiting.length) origins.delete(origin)
      })
    }
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    if (selected.active < 2) start()
    else selected.waiting.push(start)
  })
}

/** A slice timeout is an empty poll, never a successful delivery acknowledgement. */
export async function pollRelay(url: string, options: RequestInit & { signal: AbortSignal }): Promise<Response> {
  const release = await acquire(new URL(url).origin, options.signal)
  const slice = new AbortController()
  const timeout = setTimeout(() => slice.abort(), SLICE_MS)
  try {
    return await fetch(url, { ...options, signal: AbortSignal.any([options.signal, slice.signal]) })
  } catch (error) {
    if (slice.signal.aborted && !options.signal.aborted) return new Response(null, { status: 408 })
    throw error
  } finally { clearTimeout(timeout); release() }
}
