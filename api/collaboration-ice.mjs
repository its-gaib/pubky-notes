import { createHmac, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

const STUN = [{ urls: 'stun:stun.l.google.com:19302' }]
const TTL_SECONDS = 600
const CLOUDFLARE_URLS = new Set([
  'stun:stun.cloudflare.com:3478',
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:443?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turn:turn.cloudflare.com:80?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp',
  'turns:turn.cloudflare.com:443?transport=tcp',
])
const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024
const RATE_SCRIPT = `
local total = tonumber(redis.call('GET', KEYS[1]) or '0')
local client = tonumber(redis.call('GET', KEYS[2]) or '0')
if total >= tonumber(ARGV[2]) or client >= tonumber(ARGV[3]) then return 0 end
local nextTotal = redis.call('INCR', KEYS[1])
local nextClient = redis.call('INCR', KEYS[2])
if nextTotal == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if nextClient == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
return 1
`

const visibleAscii = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max && !/[^\x21-\x7e]/.test(value)

function readConfiguration(env) {
  const hasCoturn = Boolean(env.COLLABORATION_TURN_SECRET || env.COLLABORATION_TURN_URLS)
  const hasCloudflare = Boolean(env.CLOUDFLARE_TURN_KEY_ID || env.CLOUDFLARE_TURN_API_TOKEN)
  const provider = env.COLLABORATION_TURN_PROVIDER || (hasCoturn ? 'coturn' : null)
  if (!provider && !hasCloudflare) return null
  if (!['coturn', 'cloudflare'].includes(provider) || (provider === 'coturn' && hasCloudflare) || (provider === 'cloudflare' && hasCoturn)) throw new Error('Invalid relay provider')
  let relay
  if (provider === 'coturn') {
    const secret = env.COLLABORATION_TURN_SECRET
    if (!secret || secret.length < 32) throw new Error('Incomplete relay configuration')
    const urls = env.COLLABORATION_TURN_URLS?.split(',').map((url) => url.trim()).filter(Boolean) ?? []
    // No credentials, paths, fragments or unrecognized query parameters in server-provided URLs.
    if (!urls.length || urls.length > 8 || urls.some((url) => !/^turns?:([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/.test(url))) throw new Error('Invalid relay URLs')
    relay = { secret, urls }
  } else {
    const keyId = env.CLOUDFLARE_TURN_KEY_ID
    const apiToken = env.CLOUDFLARE_TURN_API_TOKEN
    if (typeof keyId !== 'string' || !keyId.length || keyId.length > 128 || /[^a-zA-Z0-9_-]/.test(keyId) || !visibleAscii(apiToken, 32, 4096)) throw new Error('Incomplete managed relay configuration')
    relay = { keyId, apiToken, secret: apiToken }
  }
  const origins = env.COLLABORATION_ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) ?? []
  if (!origins.length || origins.some((origin) => {
    try { const url = new URL(origin); return url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) } catch { return true }
  })) throw new Error('Invalid allowed origins')
  const redisUrl = new URL(env.UPSTASH_REDIS_REST_URL ?? '')
  if (redisUrl.protocol !== 'https:' || !redisUrl.hostname.endsWith('.upstash.io') || redisUrl.username || redisUrl.password || redisUrl.search || redisUrl.hash || redisUrl.pathname !== '/') throw new Error('Invalid rate-limit store')
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN
  if (!redisToken) throw new Error('Missing rate-limit store')
  return { provider, ...relay, origins: new Set(origins), redisUrl: redisUrl.href, redisToken }
}

async function readProviderResponse(response) {
  if (response.status !== 201 || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || Number(response.headers.get('content-length') ?? 0) > MAX_PROVIDER_RESPONSE_BYTES || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error('Invalid managed relay response')
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('Managed relay response too large')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
}

function cloudflareIceServers(value, config) {
  if (!Array.isArray(value?.iceServers) || !value.iceServers.length || value.iceServers.length > 8) throw new Error('Invalid managed relay servers')
  let urlCount = 0
  let hasTurn = false
  const servers = value.iceServers.map((server) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) throw new Error('Invalid managed relay server')
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
    if (!Array.isArray(urls) || !urls.length || (urlCount += urls.length) > 16 || urls.some((url) => !CLOUDFLARE_URLS.has(url))) throw new Error('Invalid managed relay URLs')
    const isTurn = urls.every((url) => url.startsWith('turn'))
    if (!isTurn) {
      if (urls.some((url) => !url.startsWith('stun:')) || server.username !== undefined || server.credential !== undefined) throw new Error('Invalid managed STUN server')
      return { urls }
    }
    const { username, credential } = server
    if (!visibleAscii(username, 1, 1024) || !visibleAscii(credential, 1, 2048) || [config.apiToken, config.redisToken].some((secret) => username.includes(secret) || credential.includes(secret))) throw new Error('Invalid managed relay credentials')
    hasTurn = true
    // Copy only WebRTC credentials; never forward arbitrary provider fields or errors.
    return { urls, username, credential }
  })
  if (!hasTurn) throw new Error('Managed relay missing TURN servers')
  return servers
}

/** Origin checks limit browser abuse; shared quotas, not Origin headers, bound anonymous credential issuance. */
export function createIceHandler({ env = process.env, fetchImpl = fetch, now = Date.now, nonce = () => randomBytes(12).toString('hex') } = {}) {
  return async function collaborationIce(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)) }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return send(405, { error: 'POST required' })
    }
    if (req.headers['x-pubky-notes-collaboration'] !== '1' || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return send(400, { error: 'Invalid request' })
    if (Number(req.headers['content-length'] ?? 0) > 1024) return send(413, { error: 'Request too large' })
    let config
    try { config = readConfiguration(env) } catch { return send(503, { error: 'Relay configuration unavailable', iceServers: STUN, relayAvailable: false }) }
    if (!config) return send(200, { iceServers: STUN, relayAvailable: false })
    if (!config.origins.has(req.headers.origin)) return send(403, { error: 'Origin not allowed' })
    // Vercel overwrites this header. Other hosts must use the socket address, never arbitrary X-Forwarded-For.
    const ip = env.VERCEL === '1' ? req.headers['x-vercel-forwarded-for'] : req.socket?.remoteAddress
    if (typeof ip !== 'string' || !isIP(ip)) return send(503, { error: 'Relay temporarily unavailable' })
    const window = Math.floor(now() / (TTL_SECONDS * 1000))
    const client = createHmac('sha256', config.secret).update(`${window}:${ip}`).digest('hex')
    try {
      const response = await fetchImpl(config.redisUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.redisToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['EVAL', RATE_SCRIPT, '2', `pubky-notes:turn:global:${window}`, `pubky-notes:turn:client:${client}`, String(TTL_SECONDS), '1000', '30']),
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      })
      if (!response.ok) throw new Error('Rate limiter unavailable')
      const result = await response.json()
      if (result?.result === 0) {
        res.setHeader('Retry-After', String(TTL_SECONDS))
        return send(429, { error: 'Relay request limit reached' })
      }
      if (result?.result !== 1) throw new Error('Rate limiter unavailable')
    } catch { return send(503, { error: 'Relay temporarily unavailable', iceServers: STUN, relayAvailable: false }) }
    const expiresAtSeconds = Math.floor(now() / 1000) + TTL_SECONDS
    if (config.provider === 'cloudflare') {
      try {
        const response = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${config.keyId}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: TTL_SECONDS }),
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        })
        const iceServers = cloudflareIceServers(await readProviderResponse(response), config)
        return send(200, { iceServers: [...STUN, ...iceServers], relayAvailable: true, expiresAt: expiresAtSeconds * 1000 })
      } catch { return send(503, { error: 'Relay temporarily unavailable', iceServers: STUN, relayAvailable: false }) }
    }
    const username = `${expiresAtSeconds}:${nonce()}`
    // coturn's TURN REST authentication deliberately specifies HMAC-SHA1.
    const credential = createHmac('sha1', config.secret).update(username).digest('base64')
    return send(200, { iceServers: [...STUN, { urls: config.urls, username, credential }], relayAvailable: true, expiresAt: expiresAtSeconds * 1000 })
  }
}

export default createIceHandler()
