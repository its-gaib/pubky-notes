import type { CollaborationIceConfiguration } from './types'

const STUN: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

export function validIceServers(value: unknown): value is RTCIceServer[] {
  return Array.isArray(value) && value.length <= 12 && value.every(server => {
    if (!server || typeof server !== 'object') return false
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
    return Array.isArray(urls) && urls.length > 0 && urls.length <= 8 && urls.every(url => typeof url === 'string' && url.length <= 512 && /^(stun|stuns|turn|turns):/.test(url))
      && (server.username === undefined || (typeof server.username === 'string' && server.username.length <= 1024))
      && (server.credential === undefined || (typeof server.credential === 'string' && server.credential.length <= 1024))
  })
}

/** One room/tab shares a bounded request and renews credentials before they expire. */
export function createIceConfigurationCache(endpoint: string | null = '/api/collaboration-ice'): {
  get(): Promise<CollaborationIceConfiguration>
  dispose(): void
} {
  let disposed = false
  let cached: CollaborationIceConfiguration | undefined
  let renewAt = 0
  let pending: Promise<CollaborationIceConfiguration> | undefined
  let controller: AbortController | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  function get(): Promise<CollaborationIceConfiguration> {
    if (disposed) return Promise.reject(new Error('Relay configuration request cancelled'))
    if (endpoint === null) return Promise.resolve({ iceServers: STUN, relayAvailable: false, expiresAt: Date.now() + 300_000 })
    if (cached && Date.now() < renewAt) return Promise.resolve(cached)
    if (pending) return pending
    const startedAt = Date.now(), requestController = new AbortController()
    controller = requestController
    timeout = setTimeout(() => requestController.abort(), 5_000)
    pending = (async () => {
      try {
        const response = await fetch(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pubky-Notes-Collaboration': '1' }, body: '{}', signal: requestController.signal,
        })
        if (!response.ok) throw new Error('Relay configuration unavailable')
        const result = await response.json() as { iceServers?: unknown; relayAvailable?: unknown; expiresAt?: unknown }
        if (disposed || requestController.signal.aborted) throw new Error('Relay configuration request cancelled')
        if (!validIceServers(result.iceServers) || typeof result.relayAvailable !== 'boolean') throw new Error('Invalid relay configuration')
        const relayAvailable = result.relayAvailable && result.iceServers.some(server => (typeof server.urls === 'string' ? [server.urls] : server.urls).some(url => /^turns?:/.test(url)))
        const expiresAt = !relayAvailable && result.expiresAt === undefined ? startedAt + 300_000 : result.expiresAt
        if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) throw new Error('Invalid relay configuration')
        if (expiresAt <= Date.now() + 60_000 || (cached?.relayAvailable && !relayAvailable)
          || (cached?.relayAvailable && expiresAt <= cached.expiresAt)) throw new Error('Relay configuration unavailable')
        cached = { iceServers: result.iceServers, relayAvailable, expiresAt }
        renewAt = expiresAt - Math.min(120_000, Math.max(60_000, (expiresAt - startedAt) / 5))
        return cached
      } finally {
        clearTimeout(timeout)
        timeout = undefined
        controller = undefined
        pending = undefined
      }
    })()
    return pending
  }

  return { get, dispose() { disposed = true; cached = undefined; controller?.abort(); clearTimeout(timeout) } }
}
