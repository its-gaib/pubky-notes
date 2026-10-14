# Collaboration hosting

The website stays on Vercel. By default, browsers exchange encrypted, signed connection setup messages through `https://httprelay.pubky.app/inbox/`, the public [Pubky HTTP relay](https://github.com/pubky/http-relay) also used by the SDK. This needs no new account or service provisioning. Optional WebSocket signaling remains available for an owned service. Document updates travel over WebRTC. A TURN relay is needed on networks where a direct connection cannot be established. TURN carries encrypted WebRTC traffic; it does not receive the application encryption keys.

The HTTP adapter splits setup envelopes into bounded temporary chunks that fit the relay's 2 KiB inbox limit, then uses explicit acknowledgements. Inbox identifiers are derived from random room IDs and browser public keys. The relay can observe connection timing and network metadata but does not receive document text or Pubky sessions. Uncollected messages expire according to the relay's TTL. This public rendezvous service has no application-specific uptime guarantee; its URL can be changed using `VITE_COLLAB_SIGNAL_URL`.

The old public y-webrtc WebSocket defaults were not operational during verification and are not used by the default deployment. Custom WSS signaling also needs its exact origin added to `connect-src` in `vercel.json`; HTTPS rendezvous is already allowed.

The first version requires overlapping online time to exchange edits. Each participant saves their own complete private document through their own Pubky session. Neither the signaling service nor TURN provides an offline document mailbox.

## Current relay availability

No managed TURN account or production coturn server has been provisioned by this change. With no server-side TURN configuration, `POST /api/collaboration-ice` returns STUN only and `relayAvailable: false`. Direct connections can work, but restrictive networks may fail to connect. The UI must not describe this configuration as having a working relay fallback.

The current [OpenRelay instructions](https://www.metered.ca/tools/openrelay/) require a free account for browser credentials. Their same page still documents a public static-auth endpoint; on 2026-10-14, our forced-relay Chromium check gathered no relay candidates from it, and TCP connections to ports 80 and 443 timed out from this development machine. This does not establish global service availability, but it does not justify configuring it as a working fallback. The identical browser check succeeded through the local coturn fixture, selecting a relay-to-relay candidate pair and delivering a synthetic message.

[PeerJS discontinued its free TURN service](https://github.com/orgs/peers/discussions/1172); its public signaling service is a separate service. Do not copy old public TURN passwords from third-party snippets or borrow another application's credentials.

## Run signaling locally or on a persistent host

```sh
node scripts/collaboration-signaling.mjs
```

The default address is `ws://127.0.0.1:4444`, allowing browser Origins `http://localhost:5173` and `http://127.0.0.1:5173`. `/health` is an HTTP health check. Configure the browser build with `VITE_COLLAB_SIGNAL_URL` to use your signaling URL.

For another origin or a deployment, use:

```sh
COLLABORATION_SIGNALING_ORIGINS=https://pubky-notes.vercel.app \
COLLABORATION_SIGNALING_HOST=127.0.0.1 \
COLLABORATION_SIGNALING_PORT=4444 \
node scripts/collaboration-signaling.mjs
```

Put a TLS reverse proxy on a persistent server in front of the loopback listener and connect browsers to `wss://your-signaling-host/`. Set `COLLABORATION_SIGNALING_TRUST_LOOPBACK_PROXY=1` only when that proxy overwrites `X-Forwarded-For` with the actual single client IP; the service trusts this header only from loopback connections. Otherwise it uses the socket IP for connection quotas. The origin allowlist is required when binding outside loopback.

The relay implements the small `subscribe`, `unsubscribe`, `publish`, and `ping` JSON protocol used by the app. It bounds payloads, connections, subscriptions, outgoing buffers, and message rates, and removes subscriptions on disconnect. It does not log messages or retain them. Topic names and traffic metadata are visible to the signaling operator; connection details inside the envelopes are encrypted by the app.

This server keeps room membership in one process. Run one instance or add a shared pub/sub layer before scaling to multiple instances. Deploying independent in-memory instances behind a load balancer will strand peers on different instances. Vercel's WebSocket support does not automatically supply shared room state; this standalone server is intended for a persistent host, not an unmodified serverless room implementation.

## ICE endpoint contract

```http
POST /api/collaboration-ice
Content-Type: application/json
X-Pubky-Notes-Collaboration: 1

{}
```

The response is `{ iceServers: RTCIceServer[], relayAvailable: boolean, expiresAt?: number }`. `expiresAt` is Unix time in **milliseconds**. Clients refresh credentials before constructing a new connection after expiration. The response is never cacheable. If no relay is configured, it contains only a public STUN address.

To use your coturn server, set these **server-only Vercel environment variables**:

| Variable | Value |
| --- | --- |
| `COLLABORATION_TURN_URLS` | Comma-separated `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp` |
| `COLLABORATION_TURN_SECRET` | The same random shared secret configured in coturn; at least 32 characters |
| `COLLABORATION_ALLOWED_ORIGINS` | Exact comma-separated application origins, with no trailing slash |
| `UPSTASH_REDIS_REST_URL` | HTTPS REST URL for a shared Upstash Redis instance |
| `UPSTASH_REDIS_REST_TOKEN` | Server-side Redis REST token with permission to execute the limiter script |

Never place these secrets in `VITE_*` variables. Configure the SPA rewrite to leave `/api/` routes reachable.

The endpoint creates ten-minute [coturn REST credentials](https://github.com/coturn/coturn/wiki/turnserver#turn-rest-api) using a timestamped username and HMAC-SHA1, as specified by coturn. The browser receives only the temporary username/password. An exact Origin check and explicit request header reduce cross-site browser abuse. They are not proof of user identity, and non-browser callers can imitate them.

One atomic [Redis REST EVAL](https://upstash.com/docs/redis/features/restapi) enforces a global limit of 1,000 issuances and a per-IP limit of 30 issuances per ten-minute window across all function instances. IP addresses are HMAC-hashed with a rotating window before becoming Redis keys. On Vercel, the endpoint uses the [platform-supplied client IP](https://vercel.com/docs/headers/request-headers); elsewhere it uses the socket address. Missing configuration, unknown client IPs, and rate-store failures do not issue TURN credentials. These limits bound issuance, not all possible bandwidth; coturn also needs allocation and bandwidth quotas.

## Optional self-hosted TURN

TURN needs a publicly reachable server/VPS with UDP and TCP ports, plus a DNS name and TLS certificate. It cannot run as an ordinary Vercel HTTP function. No VPS, account, domain, or billable resource is created by these instructions.

[`coturn.production.conf.example`](../scripts/collaboration/coturn.production.conf.example) targets coturn 4.18.0. Copy it outside the repository, set the actual interface/public IPs and domain, and generate a new private shared secret. Set that same secret in the Vercel endpoint. Mount your real certificate/key, keep the config readable only by the service operator, and do not commit it.

For a Linux host with coturn config at `/srv/pubky-notes-turn/turnserver.conf` and certificates below `/srv/pubky-notes-turn/tls`:

```sh
docker run --detach --restart unless-stopped --name pubky-notes-turn \
  --network host \
  --mount type=bind,src=/srv/pubky-notes-turn/turnserver.conf,dst=/etc/coturn/turnserver.conf,readonly \
  --mount type=bind,src=/srv/pubky-notes-turn/tls,dst=/etc/coturn/tls,readonly \
  coturn/coturn:4.18.0-r0 -c /etc/coturn/turnserver.conf
```

Allow inbound UDP/TCP 3478, TCP 5349, and UDP 49160–49200 in the firewall. TURN over TLS on TCP 443 improves compatibility with restrictive networks when that port can be dedicated to coturn. If the server is behind one-to-one NAT, configure `external-ip=PUBLIC_IP/PRIVATE_INTERFACE_IP` and forward the same ports. Restrict peer destinations to exclude internal networks and cloud metadata endpoints. The example denies private, loopback, link-local, CGNAT, and multicast ranges and sets allocation/bandwidth limits. Add any other internal networks routed from your host. Do not enable loopback peers in production. `no-tcp-relay` disables TCP **peer** allocations; browser connections to the TURN server over TCP/TLS remain available. [Coturn configuration reference](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf), [official Docker instructions](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md).

Managed TURN avoids operating this server. [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/generate-credentials/) requires an account and a server-side key, and uses its own credential-generation API rather than coturn's local HMAC secret. Supporting it would require a separate adapter. Its [published pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) on 2026-10-14 is 1,000 GB/month shared with SFU free, then $0.05/GB of egress. Metered also provides account-based managed TURN. Neither is silently configured here.

## Local relay verification

```sh
node scripts/collaboration/start-local-turn.mjs
```

This runs a uniquely named, disposable Docker container bound only to `127.0.0.1`. It uses public **test-only** fixture credentials, enables loopback peers, and removes the container when stopped. It is never a production configuration. The pinned image used during validation was `coturn/coturn:4.18.0-r0` with digest `sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3`.

For a forced-relay browser test, pass this `RTCConfiguration` through the collaboration transport options or mock only `/api/collaboration-ice` in the browser harness:

```js
{
  iceTransportPolicy: 'relay',
  iceServers: [{
    urls: 'turn:127.0.0.1:3479?transport=udp',
    username: 'pubky-notes-test',
    credential: 'local-relay-fixture-only',
  }],
}
```

Use independent browser contexts, exchange a synthetic edit, and assert via `RTCPeerConnection.getStats()` that the successful selected candidate pair has relay candidates. Merely including a TURN URL does not prove the relay carried traffic. For browser prerequisites, install Chromium with `npx playwright install chromium` and the Linux libraries with `npx playwright install-deps chromium` if needed. Do not use personal Pubky sessions or real notes in these tests.

The infrastructure regression suite runs with:

```sh
node --test scripts/test-collaboration-infrastructure.mjs
```
