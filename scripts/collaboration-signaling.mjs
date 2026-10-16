import http from 'node:http'
import { isIP } from 'node:net'
import { pathToFileURL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

const TOPIC = /^[A-Za-z0-9_-]{1,128}$/
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Stateless introductions only: the service never stores note text or invitations. */
export function createSignalingServer({
  allowedOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'],
  maxClients = 1000,
  maxClientsPerIp = 32,
  maxTopicsPerClient = 4,
  maxPayload = 64 * 1024,
  messagesPerMinute = 240,
  trustLoopbackProxy = false,
  heartbeatMs = 30_000,
} = {}) {
  if (!allowedOrigins.length) throw new Error('At least one allowed Origin is required')
  const origins = new Set(allowedOrigins)
  const topics = new Map()
  const clientsByIp = new Map()
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.writeHead(req.method === 'GET' && req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(req.method === 'GET' && req.url === '/health' ? '{"ok":true}' : '{"error":"Not found"}')
  })
  const sockets = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    let ip = req.socket.remoteAddress ?? 'unknown'
    const forwarded = req.headers['x-forwarded-for']
    if (trustLoopbackProxy && LOOPBACK.has(ip) && typeof forwarded === 'string' && isIP(forwarded)) ip = forwarded
    if (req.url !== '/' || !origins.has(req.headers.origin) || sockets.clients.size >= maxClients || (clientsByIp.get(ip) ?? 0) >= maxClientsPerIp) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      clientsByIp.set(ip, (clientsByIp.get(ip) ?? 0) + 1)
      sockets.emit('connection', ws, ip)
    })
  })
  sockets.on('connection', (ws, ip) => {
    const subscriptions = new Set()
    let alive = true
    let tokens = messagesPerMinute
    let lastRefill = Date.now()
    ws.on('pong', () => { alive = true })
    ws.on('error', () => {}) // A malformed remote connection must not crash the process.
    ws.heartbeat = () => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }
    const unsubscribe = (topic) => {
      subscriptions.delete(topic)
      const members = topics.get(topic)
      members?.delete(ws)
      if (members?.size === 0) topics.delete(topic)
    }
    ws.on('close', () => {
      for (const topic of subscriptions) unsubscribe(topic)
      const remaining = (clientsByIp.get(ip) ?? 1) - 1
      if (remaining === 0) clientsByIp.delete(ip)
      else clientsByIp.set(ip, remaining)
    })
    ws.on('message', (raw, binary) => {
      const now = Date.now()
      tokens = Math.min(messagesPerMinute, tokens + (now - lastRefill) * messagesPerMinute / 60_000)
      lastRefill = now
      if (tokens < 1) return ws.close(1008, 'Rate limit exceeded')
      tokens -= 1
      if (binary) return ws.close(1003, 'JSON messages required')
      let message
      try { message = JSON.parse(raw.toString()) } catch { return ws.close(1008, 'Invalid message') }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return ws.close(1008, 'Invalid message')
      if (message.type === 'ping') return ws.send('{"type":"pong"}')
      if (message.type === 'subscribe' || message.type === 'unsubscribe') {
        if (!Array.isArray(message.topics) || message.topics.length > maxTopicsPerClient || message.topics.some((topic) => typeof topic !== 'string' || !TOPIC.test(topic))) return ws.close(1008, 'Invalid topics')
        if (message.type === 'unsubscribe') {
          message.topics.forEach(unsubscribe)
          return
        }
        if (new Set([...subscriptions, ...message.topics]).size > maxTopicsPerClient) return ws.close(1008, 'Too many topics')
        for (const topic of message.topics) {
          subscriptions.add(topic)
          if (!topics.has(topic)) topics.set(topic, new Set())
          topics.get(topic).add(ws)
        }
        return
      }
      if (message.type !== 'publish' || typeof message.topic !== 'string' || !subscriptions.has(message.topic) || !Object.hasOwn(message, 'data')) return ws.close(1008, 'Invalid publication')
      // Forward the already-size-bounded JSON string. Reserializing arbitrary nested
      // remote data could overflow JSON.stringify's stack and terminate the server.
      const outgoing = raw.toString()
      for (const member of topics.get(message.topic) ?? []) {
        if (member.readyState !== WebSocket.OPEN) continue
        if (member.bufferedAmount > maxPayload * 4) member.terminate()
        else member.send(outgoing)
      }
    })
  })
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) ws.heartbeat()
  }, heartbeatMs)
  heartbeat.unref()
  return {
    server,
    async close() {
      clearInterval(heartbeat)
      for (const ws of sockets.clients) ws.terminate()
      await new Promise((resolve) => sockets.close(resolve))
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.COLLABORATION_SIGNALING_HOST ?? '127.0.0.1'
  const port = Number(process.env.COLLABORATION_SIGNALING_PORT ?? 4444)
  const configuredOrigins = process.env.COLLABORATION_SIGNALING_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean)
  const maxClientsPerIp = Number(process.env.COLLABORATION_SIGNALING_MAX_CLIENTS_PER_IP ?? 128)
  if (!LOOPBACK.has(host) && !configuredOrigins?.length) throw new Error('Set COLLABORATION_SIGNALING_ORIGINS before listening outside loopback')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid signaling port')
  if (!Number.isInteger(maxClientsPerIp) || maxClientsPerIp < 1 || maxClientsPerIp > 1000) throw new Error('Invalid signaling connection limit')
  const signaling = createSignalingServer({ allowedOrigins: configuredOrigins, maxClientsPerIp, trustLoopbackProxy: process.env.COLLABORATION_SIGNALING_TRUST_LOOPBACK_PROXY === '1' })
  signaling.server.listen(port, host, () => console.log(`Collaboration signaling listening on ${host}:${port}`))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => signaling.close().then(() => process.exit(0)))
}
