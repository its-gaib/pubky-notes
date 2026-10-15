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
    url: '/api/collaboration-ice',
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

test('TURN defaults to Redis limits and rejects missing limits or unsafe relay configuration', async () => {
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

const cloudflareEnv = {
  COLLABORATION_TURN_PROVIDER: 'cloudflare',
  CLOUDFLARE_TURN_KEY_ID: 'unit-test-turn-key',
  CLOUDFLARE_TURN_API_TOKEN: 'unit-test-cloudflare-token-not-a-real-credential',
  COLLABORATION_ALLOWED_ORIGINS: ORIGIN,
  UPSTASH_REDIS_REST_URL: configuredEnv.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: configuredEnv.UPSTASH_REDIS_REST_TOKEN,
}
const cloudflareServers = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  {
    urls: [
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:443?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turn:turn.cloudflare.com:80?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ],
    username: 'temporary-user',
    credential: 'temporary-password',
  },
]
const cloudflareResponse = (body = { iceServers: cloudflareServers }, options = {}) => new Response(JSON.stringify(body), { status: 201, headers: { 'content-type': 'application/json' }, ...options })
const withCloudflareResponse = (response) => async (url) => url === `${cloudflareEnv.UPSTASH_REDIS_REST_URL}/`
  ? { ok: true, json: async () => ({ result: 1 }) }
  : response()
const vercelCloudflareEnv = {
  ...cloudflareEnv,
  VERCEL: '1',
  COLLABORATION_TURN_RATE_LIMIT: 'vercel',
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
}
const vercelRequestHeaders = {
  origin: ORIGIN,
  'content-type': 'application/json',
  'x-pubky-notes-collaboration': '1',
  'x-vercel-forwarded-for': '203.0.113.2',
}

test('explicit Vercel limiter mode requests temporary Cloudflare credentials without a Redis database', async () => {
  const calls = []
  const result = await requestIce({ env: vercelCloudflareEnv, now: () => 1_700_000_000_000, fetchImpl: async (url, options) => {
    calls.push(url)
    assert.equal(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/unit-test-turn-key/credentials/generate-ice-servers')
    assert.equal(options.redirect, 'error')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, `Bearer ${cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN}`)
    assert.deepEqual(JSON.parse(options.body), { ttl: 600 })
    assert.ok(options.signal)
    return cloudflareResponse()
  } }, { headers: vercelRequestHeaders })
  assert.equal(calls.length, 1)
  assert.equal(result.status, 200)
  assert.equal(result.body.relayAvailable, true)
  assert.equal(result.body.expiresAt, 1_700_000_600_000)
  assert.deepEqual(result.body.iceServers.slice(1), cloudflareServers)
  assert.match(result.headers['Cache-Control'], /no-store/)
  assert.equal(JSON.stringify(result.body).includes(cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN), false)
})

test('Vercel limiter mode rejects invalid, missing, and mixed deployment configuration before contacting Cloudflare', async () => {
  for (const env of [
    { ...vercelCloudflareEnv, VERCEL: undefined },
    { ...vercelCloudflareEnv, VERCEL: '0' },
    { ...vercelCloudflareEnv, COLLABORATION_TURN_RATE_LIMIT: undefined },
    { ...vercelCloudflareEnv, COLLABORATION_TURN_RATE_LIMIT: 'redis' },
    { ...vercelCloudflareEnv, COLLABORATION_TURN_RATE_LIMIT: '' },
    { ...vercelCloudflareEnv, COLLABORATION_TURN_RATE_LIMIT: 'disabled' },
    { ...vercelCloudflareEnv, UPSTASH_REDIS_REST_URL: cloudflareEnv.UPSTASH_REDIS_REST_URL },
    { ...vercelCloudflareEnv, UPSTASH_REDIS_REST_TOKEN: cloudflareEnv.UPSTASH_REDIS_REST_TOKEN },
    { ...vercelCloudflareEnv, UPSTASH_REDIS_REST_TOKEN: '' },
    { ...cloudflareEnv, VERCEL: '1', COLLABORATION_TURN_RATE_LIMIT: 'vercel' },
  ]) {
    const result = await requestIce({ env, fetchImpl: () => assert.fail('Invalid config reached Cloudflare') }, { headers: vercelRequestHeaders })
    assert.equal(result.status, 503)
    assert.equal(result.body.relayAvailable, false)
  }
})

test('Vercel limiter mode only issues credentials on the exact WAF-protected route', async () => {
  for (const url of [
    undefined, '/', '/API/collaboration-ice', '/api/Collaboration-ice', '/api/collaboration-ice/',
    '/api/collaboration-ice.mjs', '/api/collaboration-ice/extra', '/api/%63ollaboration-ice',
    '/%61pi/collaboration-ice', '/api/./collaboration-ice', '//api/collaboration-ice',
    '/api/collaboration-ice?unused=1',
  ]) {
    const result = await requestIce({ env: vercelCloudflareEnv, fetchImpl: () => assert.fail('Alternate path reached Cloudflare') }, { headers: vercelRequestHeaders, url })
    assert.equal(result.status, 404)
    assert.equal(result.body.iceServers, undefined)
  }
})

test('Vercel limiter mode still rejects untrusted origins, ambiguous IP headers, and invalid requests', async () => {
  for (const [request, status] of [
    [{ method: 'GET', headers: vercelRequestHeaders }, 405],
    [{ headers: { ...vercelRequestHeaders, 'x-pubky-notes-collaboration': undefined } }, 400],
    [{ headers: { ...vercelRequestHeaders, origin: 'https://attacker.example' } }, 403],
    [{ headers: { ...vercelRequestHeaders, 'content-length': '1025' } }, 413],
    [{ headers: { ...vercelRequestHeaders, 'x-vercel-forwarded-for': undefined, 'x-forwarded-for': '203.0.113.2' } }, 503],
    [{ headers: { ...vercelRequestHeaders, 'x-vercel-forwarded-for': '203.0.113.2, 203.0.113.3' } }, 503],
    [{ headers: { ...vercelRequestHeaders, 'x-vercel-forwarded-for': ['203.0.113.2'] } }, 503],
  ]) {
    const result = await requestIce({ env: vercelCloudflareEnv, fetchImpl: () => assert.fail('Rejected request reached Cloudflare') }, request)
    assert.equal(result.status, status)
    assert.equal(result.body.iceServers?.some((server) => server.credential) ?? false, false)
  }
})

test('optional Redis token does not falsely reject credentials, but configured secrets remain filtered in Vercel mode', async () => {
  const relay = cloudflareServers[1]
  for (const [server, status] of [
    [{ ...relay, username: 'undefined-user', credential: 'temporary-undefined-password' }, 200],
    [{ ...relay, username: cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN }, 503],
    [{ ...relay, credential: `prefix-${cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN}` }, 503],
  ]) {
    const result = await requestIce({ env: vercelCloudflareEnv, fetchImpl: async () => cloudflareResponse({ iceServers: [server] }) }, { headers: vercelRequestHeaders })
    assert.equal(result.status, status)
    assert.equal(JSON.stringify(result.body).includes(cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN), false)
  }
})

test('Redis remains available explicitly and never falls back to native Vercel mode after a store failure', async () => {
  let calls = 0
  const result = await requestIce({ env: { ...cloudflareEnv, VERCEL: '1', COLLABORATION_TURN_RATE_LIMIT: 'redis' }, fetchImpl: async (url) => {
    assert.equal(++calls, 1)
    assert.equal(url, `${cloudflareEnv.UPSTASH_REDIS_REST_URL}/`)
    throw new Error('Store unavailable')
  } }, { headers: vercelRequestHeaders })
  assert.equal(calls, 1)
  assert.equal(result.status, 503)
  assert.equal(result.body.relayAvailable, false)
})

test('managed TURN issues bounded temporary credentials only after the shared quota succeeds', async () => {
  let clock = 1_700_000_000_000
  const calls = []
  const result = await requestIce({ env: cloudflareEnv, now: () => clock, fetchImpl: async (url, options) => {
    calls.push(url)
    assert.equal(options.redirect, 'error')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.ok(options.signal)
    if (calls.length === 1) {
      assert.equal(url, `${cloudflareEnv.UPSTASH_REDIS_REST_URL}/`)
      assert.equal(options.headers.Authorization, `Bearer ${cloudflareEnv.UPSTASH_REDIS_REST_TOKEN}`)
      const command = JSON.parse(options.body)
      const window = Math.floor(clock / 600_000)
      const client = createHmac('sha256', cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN).update(`${window}:198.51.100.23`).digest('hex')
      assert.equal(command[4], `pubky-notes:turn:client:${client}`)
      assert.equal(JSON.stringify(command).includes('198.51.100.23'), false)
      return { ok: true, json: async () => ({ result: 1 }) }
    }
    assert.equal(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/unit-test-turn-key/credentials/generate-ice-servers')
    assert.equal(options.headers.Authorization, `Bearer ${cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN}`)
    assert.deepEqual(JSON.parse(options.body), { ttl: 600 })
    clock += 4000
    return cloudflareResponse({ iceServers: cloudflareServers.map((server) => ({ ...server, debug: cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN })), debug: cloudflareEnv.UPSTASH_REDIS_REST_TOKEN })
  } })
  assert.equal(calls.length, 2)
  assert.equal(result.status, 200)
  assert.equal(result.body.relayAvailable, true)
  assert.equal(result.body.expiresAt, 1_700_000_600_000)
  assert.deepEqual(result.body.iceServers.slice(1), cloudflareServers)
  assert.match(result.headers['Cache-Control'], /no-store/)
  assert.equal(JSON.stringify(result.body).includes(cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN), false)
  assert.equal(JSON.stringify(result.body).includes(cloudflareEnv.UPSTASH_REDIS_REST_TOKEN), false)
})

test('managed TURN rejects mixed, incomplete, and unsafe provider configuration before any network request', async () => {
  for (const env of [
    { ...cloudflareEnv, COLLABORATION_TURN_PROVIDER: undefined },
    { ...cloudflareEnv, COLLABORATION_TURN_PROVIDER: 'unknown' },
    { ...cloudflareEnv, COLLABORATION_TURN_PROVIDER: 'coturn' },
    { ...cloudflareEnv, CLOUDFLARE_TURN_KEY_ID: '' },
    { ...cloudflareEnv, CLOUDFLARE_TURN_KEY_ID: '../different-path' },
    { ...cloudflareEnv, CLOUDFLARE_TURN_KEY_ID: 'key?query=1' },
    { ...cloudflareEnv, CLOUDFLARE_TURN_API_TOKEN: '' },
    { ...cloudflareEnv, CLOUDFLARE_TURN_API_TOKEN: 'short' },
    { ...cloudflareEnv, CLOUDFLARE_TURN_API_TOKEN: `${cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN}\n` },
    { ...cloudflareEnv, COLLABORATION_TURN_SECRET: configuredEnv.COLLABORATION_TURN_SECRET },
    { ...cloudflareEnv, COLLABORATION_TURN_URLS: configuredEnv.COLLABORATION_TURN_URLS },
    { ...cloudflareEnv, UPSTASH_REDIS_REST_TOKEN: '' },
    { ...cloudflareEnv, COLLABORATION_ALLOWED_ORIGINS: '' },
  ]) {
    const result = await requestIce({ env, fetchImpl: () => assert.fail('Invalid config reached a provider') })
    assert.equal(result.status, 503)
    assert.equal(result.body.relayAvailable, false)
  }
  const coturn = await requestIce({ env: { ...configuredEnv, COLLABORATION_TURN_PROVIDER: 'coturn' } })
  assert.equal(coturn.status, 200)
  assert.equal(coturn.body.relayAvailable, true)
})

test('managed TURN admission and quota failures never request provider credentials', async () => {
  const neverFetch = () => assert.fail('Rejected request reached a provider')
  const rejected = await requestIce({ env: cloudflareEnv, fetchImpl: neverFetch }, { headers: { origin: 'https://attacker.example', 'content-type': 'application/json', 'x-pubky-notes-collaboration': '1' } })
  assert.equal(rejected.status, 403)
  assert.equal((await requestIce({ env: cloudflareEnv, fetchImpl: neverFetch }, { socket: {} })).status, 503)
  for (const [quota, status] of [[0, 429], [undefined, 503]]) {
    let calls = 0
    const result = await requestIce({ env: cloudflareEnv, fetchImpl: async (url) => {
      assert.equal(++calls, 1)
      assert.equal(url, `${cloudflareEnv.UPSTASH_REDIS_REST_URL}/`)
      return { ok: true, json: async () => ({ result: quota }) }
    } })
    assert.equal(result.status, status)
    assert.equal(calls, 1)
    assert.equal(result.body.expiresAt, undefined)
    assert.equal(result.body.iceServers?.some((server) => server.credential) ?? false, false)
  }
})

test('managed TURN rejects malformed responses, unknown destinations, and oversized credential payloads', async () => {
  const relay = cloudflareServers[1]
  for (const body of [
    null,
    {},
    { iceServers: [] },
    { iceServers: Array(9).fill(relay) },
    { iceServers: [null] },
    { iceServers: [cloudflareServers[0]] },
    { iceServers: [{ ...relay, urls: [] }] },
    { iceServers: [{ ...relay, urls: Array(17).fill(relay.urls[0]) }] },
    { iceServers: [{ ...relay, urls: ['turn:127.0.0.1:3478?transport=udp'] }] },
    { iceServers: [{ ...relay, urls: ['turn:turn.cloudflare.com.attacker.example:3478?transport=udp'] }] },
    { iceServers: [{ ...relay, urls: ['turn:turn.cloudflare.com:53?transport=udp'] }] },
    { iceServers: [{ ...relay, urls: ['turns:turn.cloudflare.com:443?transport=udp'] }] },
    { iceServers: [{ ...relay, urls: [`${relay.urls[0]}&extra=1`] }] },
    { iceServers: [{ ...relay, urls: [...relay.urls, cloudflareServers[0].urls[0]] }] },
    { iceServers: [{ ...cloudflareServers[0], username: 'unexpected' }, relay] },
    { iceServers: [{ ...relay, username: '' }] },
    { iceServers: [{ ...relay, username: 'x'.repeat(1025) }] },
    { iceServers: [{ ...relay, credential: 'x'.repeat(2049) }] },
    { iceServers: [{ ...relay, credential: {} }] },
    { iceServers: [{ ...relay, credential: 'line\nbreak' }] },
    { iceServers: [{ ...relay, credential: cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN }] },
    { iceServers: [{ ...relay, username: cloudflareEnv.UPSTASH_REDIS_REST_TOKEN }] },
  ]) {
    const result = await requestIce({ env: cloudflareEnv, fetchImpl: withCloudflareResponse(() => cloudflareResponse(body)) })
    assert.equal(result.status, 503)
    assert.deepEqual(result.body, { error: 'Relay temporarily unavailable', iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], relayAvailable: false })
  }
  for (const response of [
    () => cloudflareResponse({ error: cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN }, { status: 403 }),
    () => cloudflareResponse(undefined, { status: 302, headers: { location: 'https://attacker.example' } }),
    () => new Response('{', { status: 201, headers: { 'content-type': 'application/json' } }),
    () => cloudflareResponse(undefined, { headers: { 'content-type': 'text/html' } }),
    () => cloudflareResponse(undefined, { headers: { 'content-type': 'application/json', 'content-length': '16385' } }),
    () => cloudflareResponse({ iceServers: cloudflareServers, oversized: 'x'.repeat(16385) }),
    () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"oversized":"'))
      controller.enqueue(new Uint8Array(16385))
      controller.close()
    } }), { status: 201, headers: { 'content-type': 'application/json' } }),
    () => { throw new Error(`upstream secret ${cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN}`) },
  ]) {
    const result = await requestIce({ env: cloudflareEnv, fetchImpl: withCloudflareResponse(response) })
    assert.equal(result.status, 503)
    assert.equal(result.body.relayAvailable, false)
    assert.equal(result.body.expiresAt, undefined)
    assert.equal(JSON.stringify(result.body).includes(cloudflareEnv.CLOUDFLARE_TURN_API_TOKEN), false)
  }
})

test('managed TURN request aborts on its fixed deadline and returns no provider diagnostics', async (t) => {
  const deadlines = []
  t.mock.method(AbortSignal, 'timeout', (duration) => {
    deadlines.push(duration)
    const controller = new AbortController()
    if (duration === 5000) queueMicrotask(() => controller.abort(new DOMException('Upstream timed out', 'TimeoutError')))
    return controller.signal
  })
  const result = await requestIce({ env: cloudflareEnv, fetchImpl: async (url, options) => {
    if (url === `${cloudflareEnv.UPSTASH_REDIS_REST_URL}/`) return { ok: true, json: async () => ({ result: 1 }) }
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  } })
  assert.deepEqual(deadlines, [3000, 5000])
  assert.equal(result.status, 503)
  assert.equal(result.body.relayAvailable, false)
  assert.equal(JSON.stringify(result.body).includes('Upstream'), false)
})
