import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import { WebSocket } from 'ws'
import { createSignalingServer } from './collaboration-signaling.mjs'
import { createIceHandler } from '../api/collaboration-ice.mjs'

const ORIGIN = 'https://notes.example'

async function start(t, options = {}) {
  const signaling = createSignalingServer({ allowedOrigins: [ORIGIN], ...options })
  signaling.server.listen(0, '127.0.0.1')
  await once(signaling.server, 'listening')
  t.after(() => signaling.close())
  return `ws://127.0.0.1:${signaling.server.address().port}`
}

async function connect(url, origin = ORIGIN) {
  const ws = new WebSocket(url, { origin })
  await once(ws, 'open')
  return ws
}

const send = (ws, value) => ws.send(JSON.stringify(value))
const nextMessage = async (ws) => JSON.parse((await once(ws, 'message'))[0].toString())
const subscribe = async (ws, topic) => {
  const pong = nextMessage(ws)
  send(ws, { type: 'subscribe', topics: [topic] })
  send(ws, { type: 'ping' })
  assert.deepEqual(await pong, { type: 'pong' })
}

test('signaling forwards encrypted envelopes only inside a subscribed room and honors unsubscribe', async (t) => {
  const url = await start(t)
  const [alice, bob, outsider] = await Promise.all([connect(url), connect(url), connect(url)])
  await Promise.all([subscribe(alice, 'room_A'), subscribe(bob, 'room_A'), subscribe(outsider, 'room_B')])
  const outsiders = []
  outsider.on('message', (data) => outsiders.push(data.toString()))
  const publication = { type: 'publish', topic: 'room_A', data: { version: 1, iv: 'opaque', ciphertext: 'encrypted-connection-details' } }
  const delivered = Promise.all([nextMessage(alice), nextMessage(bob)])
  send(alice, publication)
  assert.deepEqual(await delivered, [publication, publication])
  assert.deepEqual(outsiders, [])
  const acknowledged = nextMessage(bob)
  send(bob, { type: 'unsubscribe', topics: ['room_A'] })
  send(bob, { type: 'ping' })
  await acknowledged
  const unexpected = []
  bob.on('message', (data) => unexpected.push(data.toString()))
  const echoed = nextMessage(alice)
  send(alice, publication)
  await echoed
  assert.deepEqual(unexpected, [])
})

test('signaling rejects unapproved browser origins and invitation-like URL query strings', async (t) => {
  const url = await start(t)
  await assert.rejects(connect(url, 'https://attacker.example'), /403/)
  await assert.rejects(connect(`${url}/?secret=should-not-be-here`), /403/)
})

test('signaling prevents publication to an unsubscribed room', async (t) => {
  const ws = await connect(await start(t))
  const closed = once(ws, 'close')
  send(ws, { type: 'publish', topic: 'unknown', data: 'envelope' })
  assert.equal((await closed)[0], 1008)
})

test('signaling bounds topic subscriptions, messages, and payloads', async (t) => {
  await t.test('topic limit', async (t) => {
    const ws = await connect(await start(t, { maxTopicsPerClient: 1 }))
    const closed = once(ws, 'close')
    send(ws, { type: 'subscribe', topics: ['one', 'two'] })
    assert.equal((await closed)[0], 1008)
  })
  await t.test('message rate', async (t) => {
    const ws = await connect(await start(t, { messagesPerMinute: 2 }))
    const closed = once(ws, 'close')
    for (let i = 0; i < 3; i++) send(ws, { type: 'ping' })
    assert.equal((await closed)[0], 1008)
  })
  await t.test('oversized payload', async (t) => {
    const ws = await connect(await start(t, { maxPayload: 128 }))
    const closed = once(ws, 'close')
    ws.send('x'.repeat(129))
    assert.equal((await closed)[0], 1009)
  })
})

test('signaling applies connection quotas and releases the quota after disconnect', async (t) => {
  const url = await start(t, { maxClientsPerIp: 1 })
  const first = await connect(url)
  await assert.rejects(connect(url), /403/)
  const closed = once(first, 'close')
  first.close()
  await closed
  const next = await connect(url)
  assert.equal(next.readyState, WebSocket.OPEN)
})

test('malformed messages close only the offending signaling socket', async (t) => {
  const url = await start(t)
  const malformed = await connect(url)
  const closed = once(malformed, 'close')
  malformed.send('{')
  assert.equal((await closed)[0], 1008)
  const healthy = await connect(url)
  const pong = nextMessage(healthy)
  send(healthy, { type: 'ping' })
  assert.deepEqual(await pong, { type: 'pong' })
})

test('deeply nested remote data cannot crash signaling while forwarding a bounded envelope', async (t) => {
  const ws = await connect(await start(t))
  await subscribe(ws, 'room')
  const delivered = once(ws, 'message')
  const raw = '{"type":"publish","topic":"room","data":' + '['.repeat(10_000) + '0' + ']'.repeat(10_000) + '}'
  ws.send(raw)
  assert.equal((await delivered)[0].toString(), raw)
  const pong = nextMessage(ws)
  send(ws, { type: 'ping' })
  assert.deepEqual(await pong, { type: 'pong' })
})

const configuredEnv = {
  COLLABORATION_TURN_SECRET: 'test-only-32-byte-secret-never-for-production',
  COLLABORATION_TURN_URLS: 'turn:relay.example:3478?transport=udp,turns:relay.example:5349?transport=tcp',
  COLLABORATION_ALLOWED_ORIGINS: ORIGIN,
  UPSTASH_REDIS_REST_URL: 'https://unit-test.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'unit-test-token',
}

async function requestIce(options = {}, request = {}) {
  const headers = {}
  let body
  const res = { setHeader(name, value) { headers[name] = value }, end(value) { body = JSON.parse(value) }, statusCode: 0 }
  const req = {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-pubky-notes-collaboration': '1' },
    socket: { remoteAddress: '198.51.100.23' },
    ...request,
  }
  await createIceHandler({ env: configuredEnv, fetchImpl: async () => ({ ok: true, json: async () => ({ result: 1 }) }), ...options })(req, res)
  return { status: res.statusCode, body, headers }
}

test('unconfigured ICE endpoint honestly offers only STUN without contacting a credential store', async () => {
  const result = await requestIce({ env: {}, fetchImpl: () => { throw new Error('Must not fetch') } })
  assert.equal(result.status, 200)
  assert.equal(result.body.relayAvailable, false)
  assert.equal(result.body.iceServers.length, 1)
  assert.equal(result.body.iceServers[0].username, undefined)
  assert.match(result.headers['Cache-Control'], /no-store/)
})

test('TURN credentials follow coturn HMAC protocol and expire in ten minutes', async () => {
  let command
  const result = await requestIce({ now: () => 1_700_000_000_000, nonce: () => 'unique-client', fetchImpl: async (_url, options) => {
    command = JSON.parse(options.body)
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal)
    return { ok: true, json: async () => ({ result: 1 }) }
  } })
  assert.equal(result.status, 200)
  assert.equal(result.body.relayAvailable, true)
  assert.equal(result.body.expiresAt, 1_700_000_600_000)
  const turn = result.body.iceServers[1]
  assert.equal(turn.username, '1700000600:unique-client')
  assert.equal(turn.credential, createHmac('sha1', configuredEnv.COLLABORATION_TURN_SECRET).update(turn.username).digest('base64'))
  assert.equal(command[0], 'EVAL')
  assert.equal(command[2], '2')
  assert.deepEqual(command.slice(-3), ['600', '1000', '30'])
  assert.equal(JSON.stringify(command).includes('198.51.100.23'), false)
  assert.equal(JSON.stringify(result.body).includes(configuredEnv.COLLABORATION_TURN_SECRET), false)
  assert.equal(JSON.stringify(result.body).includes(configuredEnv.UPSTASH_REDIS_REST_TOKEN), false)
})

test('TURN admission rejects other origins and missing explicit JSON requests before issuing credentials', async () => {
  const neverFetch = async () => { assert.fail('Rejected request reached credential store') }
  assert.equal((await requestIce({ fetchImpl: neverFetch }, { method: 'GET' })).status, 405)
  assert.equal((await requestIce({ fetchImpl: neverFetch }, { headers: { origin: ORIGIN } })).status, 400)
  assert.equal((await requestIce({ fetchImpl: neverFetch }, { headers: { origin: 'https://attacker.example', 'content-type': 'application/json', 'x-pubky-notes-collaboration': '1' } })).status, 403)
})

test('TURN cannot be enabled without shared rate limits or approved relay URL syntax', async () => {
  for (const env of [
    { ...configuredEnv, UPSTASH_REDIS_REST_TOKEN: '' },
    { ...configuredEnv, UPSTASH_REDIS_REST_URL: 'http://unit-test.upstash.io' },
    { ...configuredEnv, COLLABORATION_ALLOWED_ORIGINS: '*' },
    { ...configuredEnv, COLLABORATION_TURN_URLS: 'turn:username:password@relay.example' },
    { ...configuredEnv, COLLABORATION_TURN_SECRET: 'short' },
  ]) {
    const result = await requestIce({ env })
    assert.equal(result.status, 503)
    assert.equal(result.body.relayAvailable, false)
  }
})

test('TURN quotas and store failures fail closed without returning relay credentials', async () => {
  const limited = await requestIce({ fetchImpl: async () => ({ ok: true, json: async () => ({ result: 0 }) }) })
  assert.equal(limited.status, 429)
  assert.equal(limited.body.iceServers, undefined)
  assert.equal(limited.headers['Retry-After'], '600')
  for (const fetchImpl of [
    async () => { throw new Error('secret upstream failure') },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ error: 'Redis unavailable' }) }),
  ]) {
    const result = await requestIce({ fetchImpl })
    assert.equal(result.status, 503)
    assert.equal(result.body.relayAvailable, false)
    assert.equal(JSON.stringify(result.body).includes('secret upstream failure'), false)
  }
})

test('TURN rate limits use Vercel-provided IP only on Vercel and ignore arbitrary forwarded headers elsewhere', async () => {
  assert.equal((await requestIce({ env: { ...configuredEnv, VERCEL: '1' } })).status, 503)
  const headers = { origin: ORIGIN, 'content-type': 'application/json', 'x-pubky-notes-collaboration': '1', 'x-vercel-forwarded-for': '203.0.113.2' }
  assert.equal((await requestIce({ env: { ...configuredEnv, VERCEL: '1' } }, { headers })).status, 200)
  assert.equal((await requestIce({}, { headers, socket: {} })).status, 503)
})
