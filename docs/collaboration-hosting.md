# Collaboration hosting

The website stays on Vercel. By default, browsers exchange encrypted, signed connection setup messages through `https://httprelay.pubky.app/inbox/`, the public [Pubky HTTP relay](https://github.com/pubky/http-relay) also used by the SDK. This needs no new account or service provisioning. Optional WebSocket signaling remains available for an owned service. Document updates travel over WebRTC. A TURN relay is needed on networks where a direct connection cannot be established. TURN carries encrypted WebRTC traffic; it does not receive the application encryption keys.

The HTTP adapter splits setup envelopes into bounded temporary chunks that fit the relay's 2 KiB inbox limit, then uses explicit acknowledgements. Each admitted pair derives its own child room from the original random room ID and both browser public keys; directional inboxes stay separate. Initial discovery uses bounded, signed announcements in separate striped rendezvous inboxes with randomized retries, never a shared-inbox delivery acknowledgement. A fair scheduler allows at most two long polls per origin and rotates idle reads, leaving HTTP/1.1 connections available for uploads and acknowledgements. The relay can observe connection timing and network metadata but does not receive document text or Pubky sessions. Uncollected messages expire according to the relay's TTL. This public rendezvous service has no application-specific uptime guarantee; its URL can be changed using `VITE_COLLAB_SIGNAL_URL`.

The old public y-webrtc WebSocket defaults were not operational during verification and are not used by the default deployment. Custom WSS signaling also needs its exact origin added to `connect-src` in `vercel.json`; HTTPS rendezvous is already allowed.

Groups support at most ten admitted accounts, including the creator. Each browser connects to at most nine admitted peers (45 connections across a full group). The creator must be online to admit new accounts; already admitted peers can reconnect and edit without the creator using their stored, signed roster. This version permits one browser key per account and keeps offline members’ places. Participants require overlapping online time to exchange edits. Each participant saves their own complete private document through their own Pubky session. Neither the signaling service nor TURN provides an offline document mailbox.

## Current relay availability

Cloudflare TURN was activated on `https://pubky-notes.vercel.app` on 2026-10-16. Production credential issuance and four live Chromium tests passed using disposable testnet accounts, public Pubky signaling, and direct ICE disabled. These covered relayed editing, accelerated credential renewal, and TURN over TLS on port 443. A 10.4-minute TLS session also verified renewal with the actual 600-second credential lifetime: both original connections closed, replacement relay allocations carried edits without repeated participant approval, and both private copies saved converged edits at least 15 seconds after both original credentials expired. Other deployments still need their own provider configuration and verification.

The endpoint supports Cloudflare Realtime TURN and coturn, but neither is activated by deploying this code alone. With no server-side TURN configuration, `POST /api/collaboration-ice` returns STUN only and `relayAvailable: false`. Direct connections can work, but restrictive networks may fail to connect. Verify the deployed endpoint and an actual relayed connection before describing a deployment as having a working relay fallback.

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

The executable defaults to 128 connections per IP to accommodate a ten-person mesh behind one NAT, while retaining its overall connection and message limits. Set `COLLABORATION_SIGNALING_MAX_CLIENTS_PER_IP` to tune this bound (1–1000).

The relay implements the small `subscribe`, `unsubscribe`, `publish`, and `ping` JSON protocol used by the app. It bounds payloads, connections, subscriptions, outgoing buffers, and message rates, and removes subscriptions on disconnect. It does not log messages or retain them. Topic names and traffic metadata are visible to the signaling operator; connection details inside the envelopes are encrypted by the app.

This server keeps room membership in one process. Run one instance or add a shared pub/sub layer before scaling to multiple instances. Deploying independent in-memory instances behind a load balancer will strand peers on different instances. Vercel's WebSocket support does not automatically supply shared room state; this standalone server is intended for a persistent host, not an unmodified serverless room implementation.

## ICE endpoint contract

```http
POST /api/collaboration-ice
Content-Type: application/json
X-Pubky-Notes-Collaboration: 1

{}
```

The response is `{ iceServers: RTCIceServer[], relayAvailable: boolean, expiresAt?: number }`. `expiresAt` is Unix time in **milliseconds**. All connections in one browser share a bounded credential cache, so joining nine peers does not require nine API issuances. While connected, the browser requests fresh credentials before expiration and reconnects with them to establish a fresh TURN allocation. This can briefly pause live sync; the pinned participant does not need approval again. Temporary refresh failures keep the existing connection while its credentials remain valid and retry with bounded delays. A new connection after expiration also requests fresh credentials. The response is never cacheable. If no relay is configured, it contains only a public STUN address.

### Managed Cloudflare TURN

This option runs credential issuance on Vercel while Cloudflare carries the relayed traffic. No database is needed when using the Vercel Firewall limiter below. Create a TURN key in your own Cloudflare account, following the [official credential instructions](https://developers.cloudflare.com/realtime/turn/generate-credentials/). Enable and verify the firewall rule **before** configuring these **server-only Vercel environment variables**:

| Variable | Value |
| --- | --- |
| `COLLABORATION_TURN_PROVIDER` | `cloudflare` |
| `CLOUDFLARE_TURN_KEY_ID` | The Cloudflare TURN key ID |
| `CLOUDFLARE_TURN_API_TOKEN` | The API token for that TURN key, not a browser credential |
| `COLLABORATION_ALLOWED_ORIGINS` | `https://pubky-notes.vercel.app`, or exact comma-separated application origins without trailing slashes |
| `COLLABORATION_TURN_RATE_LIMIT` | `vercel`, after enabling the project firewall rule below |

Remove any `COLLABORATION_TURN_SECRET` and `COLLABORATION_TURN_URLS` values when selecting Cloudflare. Also remove both `UPSTASH_REDIS_REST_*` variables when selecting `vercel`; even an empty leftover Redis variable is rejected. Mixed or incomplete provider/limiter configurations fail closed. The provider selector must be explicit for Cloudflare. The endpoint requires Vercel's injected `VERCEL=1` marker for native firewall mode; do not set that marker manually on another host. The API cannot create or inspect the firewall rule, so configuring and verifying that rule is a deployment prerequisite.

After the configured limiter and origin checks, the endpoint calls Cloudflare's fixed HTTPS credential API with a ten-minute TTL. It rejects redirects, times out after five seconds, bounds the response to 16 KiB, and accepts only explicitly allowlisted Cloudflare STUN/TURN addresses and transports on ports 3478, 443, 80, and 5349. It returns only validated temporary ICE credentials, with expiry measured conservatively from the request start. Provider errors and long-term secrets are not returned to browsers. Custom Cloudflare TURN domains are not supported by this adapter.

Redeploy after adding the variables, then verify the production endpoint returns `relayAvailable: true`. Finish activation by testing a real connection with `iceTransportPolicy: 'relay'` and confirming the selected candidate pair in `getStats()` uses a relay. A successful credential response alone does not prove traffic can traverse the relay.

### Existing coturn server

To use your coturn server, set these **server-only Vercel environment variables**:

| Variable | Value |
| --- | --- |
| `COLLABORATION_TURN_PROVIDER` | `coturn`; optional for existing deployments using only the coturn variables |
| `COLLABORATION_TURN_URLS` | Comma-separated `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp` |
| `COLLABORATION_TURN_SECRET` | The same random shared secret configured in coturn; at least 32 characters |
| `COLLABORATION_ALLOWED_ORIGINS` | Exact comma-separated application origins, with no trailing slash |
| `COLLABORATION_TURN_RATE_LIMIT` | `vercel` after enabling the project firewall rule, or `redis` with the shared store below |

Never place these secrets in `VITE_*` variables. Configure the SPA rewrite to leave `/api/` routes reachable.

The endpoint creates ten-minute [coturn REST credentials](https://github.com/coturn/coturn/wiki/turnserver#turn-rest-api) using a timestamped username and HMAC-SHA1, as specified by coturn. The browser receives only the temporary username/password. An exact Origin check and explicit request header reduce cross-site browser abuse. They are not proof of user identity, and non-browser callers can imitate them.

### Credential rate limits

Both providers require one explicitly configured limiter or the default Redis limiter. There is no unthrottled fallback. Exact Origin checks and the explicit request header reduce browser abuse but are not authentication; non-browser clients can imitate them. On Vercel, the endpoint requires the [platform-supplied client IP](https://vercel.com/docs/headers/request-headers); elsewhere Redis mode uses the socket address. Missing or ambiguous client IPs never receive TURN credentials.

For the database-free Vercel option:

1. Create and enable a project [Vercel Firewall rate-limit rule](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) for every pathname beginning `/api/`, on **all project domains and all request methods**. Use a fixed window of **30 requests per 600 seconds per client IP**, with the rate-limit action that returns HTTP 429 after the limit. Use the platform client IP, not a caller-provided header. Scope must include deployment URLs as well as the production alias.
2. Verify the active rule actually returns HTTP 429 after repeated requests before enabling native mode. Check its coverage on production and deployment domains. Keep the rule enabled across deployments. Native mode accepts only the exact raw request URL `/api/collaboration-ice`, with no query, encoded path, case variation, extension, or trailing slash, so alternate function URLs cannot mint credentials outside that route.
3. Set `COLLABORATION_TURN_RATE_LIMIT=vercel`, remove both Redis variables, and deploy. The function relies on the verified firewall rule; `VERCEL=1` alone does not prove a rule exists.

Vercel's native limit is **per region and per IP**, not a globally shared issuance limit or a bandwidth cap. Requests from many addresses or regions can exceed 30 in aggregate. Requests to other `/api/` paths also count under this rule. Monitor Cloudflare usage and billing in the account. To roll back, first disable TURN issuance and redeploy, or switch to a working Redis configuration and redeploy; **only then remove the firewall rule**. Never remove the rule while a deployment still issues credentials in `vercel` mode.

For an optional globally shared Redis limiter, leave `COLLABORATION_TURN_RATE_LIMIT` unset or set it to `redis` and configure:

| Variable | Value |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | HTTPS REST URL for a shared Upstash Redis instance |
| `UPSTASH_REDIS_REST_TOKEN` | Server-side Redis REST token with permission to execute the limiter script |

One atomic [Redis REST EVAL](https://upstash.com/docs/redis/features/restapi) enforces a global limit of 1,000 issuances and a per-IP limit of 30 issuances per ten-minute window across all function instances, before generating credentials. IP addresses are HMAC-hashed with the selected provider's server-side secret and a rotating window before becoming Redis keys. Missing store configuration and store failures do not issue credentials, including on Vercel; the function never switches limiter modes automatically. These limits bound issuance, not all possible bandwidth; coturn also needs allocation and bandwidth quotas.

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

The managed Cloudflare option above avoids operating a TURN server. Check the provider's [current pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) and account usage before activation. Neither a managed account nor self-hosted infrastructure is silently configured here.

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

With the disposable local Pubky testnet running, the browser suite can use the deployed credential endpoint instead of local coturn:

```sh
COLLAB_E2E_ICE_ENDPOINT=https://pubky-notes.vercel.app/api/collaboration-ice \
  npx playwright test e2e/collaboration.spec.ts --grep 'real TURN collaboration' --workers=1
```

These tests force relay candidates and check actual editing and replacement allocations after credential renewal. The renewal test shortens only the first response's advertised expiry to exercise the real timer quickly; it does not test Cloudflare's server-side expiry policy. Managed-credential traces are disabled, and errors omit credential responses. The tests use disposable local accounts and synthetic notes even when Cloudflare carries the encrypted traffic.

Set `COLLAB_E2E_ICE_TRANSPORT=tls` to restrict the browser to Cloudflare TURN over TLS on port 443 and verify `relayProtocol: tls` in the selected candidate stats. Set `COLLAB_E2E_SIGNAL_URL=https://httprelay.pubky.app/inbox/` to exercise the public signaling service as well.

For a real credential-lifetime check, also set `COLLAB_E2E_LONG_TURN=1` and select `--grep 'original 600-second'`. This opt-in test leaves the provider's expiry unchanged, exchanges and saves edits throughout the session, checks that replacement relay allocations work before expiry, and continues at least 15 seconds beyond both original credential expiries. Allow approximately eleven minutes for this test; it is skipped in ordinary runs.

The infrastructure regression suite runs with:

```sh
node --test scripts/test-collaboration-infrastructure.mjs
```
