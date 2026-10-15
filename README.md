# Pubky Notes

A Markdown notebook for Pubky. Built with React, TypeScript and Vite, using the official Pubky SDK and authentication patterns from the [basic Pubky app template](https://github.com/pubky/pubky-app-templates/tree/main/basic-pubky-app).

## Run

Requires Node.js 22.12 or later.

```sh
npm ci
npm run dev
npm test
npm run build
```

The checked-in `.env` selects **Pubky mainnet**. Sign in with an existing identity in **Pubky Ring** using the QR code, phone link, or copyable authorization link. The app never requests a secret key or creates a mainnet identity. Drafts are saved on this device in IndexedDB, including while signed out. Signing in automatically adopts those guest drafts into the approved account and uploads them privately while keeping the current note open. An untouched demonstration sample is not uploaded. Account caches stay separate; signing out does not turn an account’s notes into guest drafts.

For a separately running local testnet, copy `.env.example` to `.env.local`, set `VITE_PUBKY_TESTNET=true`, and configure `VITE_PUBKY_TESTNET_HOST` if necessary. The default testnet relay uses port 15412. The production Vercel headers intentionally allow HTTPS connections; use Vite locally for the HTTP testnet. Production uses the SDK’s default auth relay unless `VITE_PUBKY_HTTP_RELAY` is configured.

## Storage and sharing

- Canonical notes: `/priv/notes/<id>.json`.
- Explicit public snapshots: `/pub/notes/<id>.json`.
- Records contain `id`, `title`, `content`, `createdAt`, and `updatedAt`, plus a private Yjs `crdt` envelope and optional `folder` / `deleted` metadata. Ordinary notes retain CRDT version 1. Collaborative notes use version 2: `update` contains shared title/content and `personal` contains the account's separate folder/Trash metadata and version timeline. Nested folders remain logical paths such as `Work/Ideas`; all files stay directly under their storage root. Empty folders are recorded separately at `/priv/notes/folders`. Public snapshots contain only the five public note fields. Moving a note does not change its ID or public link.
- Pubky Ring shows the authentication client ID `pubky-notes`. The app requests read/write access to exactly two roots: `/priv/notes/` and `/pub/notes/`.
- The account row reads your public name and avatar from `/pub/pubky.app/profile.json`, following [Pubky App Specs](https://github.com/pubky/pubky-app-specs/blob/main/SPEC.md#pubkyappuser). Click the abbreviated identifier to copy your complete `pubky…` identifier. Profile reads require no additional permissions; a missing profile or image falls back without blocking your notebook.
- Edits save locally first, then synchronize to `/priv`. The app distinguishes device storage from verified homeserver storage. Publishing saves the private draft and writes the specific text reviewed when Publish was clicked; newly merged remote private text is not silently published. Later edits remain private until **Update public copy** is clicked.
- A public link opens a read-only Markdown page without authentication. Public notes are publicly readable and discoverable, not secret links.
- Each saved note has a stable editor URL, `/pubky<owner>/priv/notes/<id>.json`, even when it also has a published copy. Opening a private link requires that owner's connected account; the link does not grant access or publish the note. **Copy note link** copies it and briefly explains that sharing with other people requires publishing a public copy. Guest drafts use `/local/notes/<id>.json`, which works only with that browser's local notebook; signing in updates the address to the adopted note's private path.
- Unpublish removes the public snapshot. Delete removes the public snapshot and records a private CRDT deletion marker. Trash retains the note and concurrent offline edits; Restore makes it visible again without republishing. This is recoverable deletion, not secure erasure. Unpublishing cannot retract copies already downloaded.
- Pubky `/priv` restricts access but **is not end-to-end encrypted**. The homeserver operator can read it. See the [private storage contract](https://pubky.org/private-storage.md).

Authentication uses scoped Pubky Ring grant sessions. SDK-managed IndexedDB stores session credentials separately from the app’s account-scoped note cache and upload outbox. LocalStorage contains the opaque session record ID, last account identifier, and sidebar layout preferences. Private note text and editing history are stored on this device and on the homeserver. Markdown raw HTML is disabled; remote images in notes render as text to avoid tracking readers.

## Features and boundaries

Search across all note titles and Markdown content, nested folders, Markdown editing/preview with GFM tables and task lists, formatting tools, `.md` import/export, explicit publish/update/unpublish, and responsive navigation. New notes start with the concise Markdown sample as a template; imported files retain their own content. Search covers all live notes regardless of the selected folder. Use Ctrl/⌘+S to save immediately.

One sidebar contains the folder and note tree and a search field. Search looks through every live note’s title and Markdown, showing matching notes with their folder ancestors expanded; clearing search restores collapsed folders. The small **Notebook options** menu contains Trash, Markdown import, refresh, and Help. Trash keeps deleted notes recoverable and offers **Back to notes**; switching this view leaves the open editor unchanged. Each note has a muted lock for private notes or a green globe for a published copy, with a tooltip distinguishing unpublished changes or a public copy awaiting removal.

Manage folders entirely in this sidebar. **New folder** and **New subfolder** open an inline name field. Click a folder to select it, then click its name again to rename it; Enter saves and Escape cancels. The adjacent trash icon works only when there are no notes or child folders. Drag notes or folders onto a destination folder, onto the **Notes** heading, or into the empty space below the tree to move them to the top level; a **Move to top level** hint appears while dragging. Folder moves and renames include their descendants. The **Move to…** row menus offer the same destinations for keyboard and touch use. New notes inherit the selected folder; click **Notes** to select the top level. Empty folders persist, and moving items preserves note URLs and public snapshots.

On desktop, drag the sidebar’s right border to resize it, or focus the border and use the arrow keys. Its width ranges from 160–900 px, constrained to leave at least 320 px for the editor. The preferred width is remembered on this device and retained through collapsing or temporarily narrowing the window. The chevron stays inside the right border and is the only visible control when collapsed. Mobile uses a single overlay that closes after opening or creating a note.

Notes are limited to 250,000 content characters / 4 MiB serialized including CRDT history, titles to 200 characters, and each private/public root to 2,000 entries. A timeline has at most 5,000 saved versions, with each encoded checkpoint limited to 128 KiB before base64 encoding. The edit attribution journal supports at most 20,000 events and 4 Mi characters of referenced change text; a Changes view displays at most 1 Mi characters per checkpoint. Larger views remain available in Preview. Limits produce a visible error and never prune older versions. Imports accept files up to 512 KiB and must also satisfy the note limits when saving. Lists paginate; note downloads are bounded and use limited concurrency.

Version history starts with a note's initial text. The browser records compact Yjs snapshots after one second without changes, on explicit Save, and when flushing before leaving a note; raw edits still persist immediately. CLI text edits record one version per command. The History button opens a read-only timeline with a slider and Play/Pause. Restore applies historical title/content as a new edit after checkpointing the current text, preserving later versions, folder, Trash state, and the existing public copy. A shared copy starts a fresh private timeline; invitees record the text they receive, without inheriting the inviter's private version log. Concurrent offline versions are ordered by their recorded timestamps with an ID tie-breaker, not a server-authoritative global edit order. No historical reconstruction or migration is performed for pre-launch files.

The browser and CLI use compatible [Yjs updates](https://docs.yjs.dev/api/document-updates). Text edits become incremental operations. Each private save locks the note, merges remote history, writes the result, and reads it back before acknowledging the upload. Failed writes remain queued locally; background refresh and reconnection reconcile cached and remote states. Incompatible histories are retained as separate recovery copies, and later edits from stale tabs follow their own recovered history. Publishing after recovery requires a fresh publish action on the recovered note. The CLI still requires a current revision before changing a note.

Concurrent edits converge, but overlapping prose can need human cleanup. CRDT history retains earlier private text; no automatic compaction or permanent purge is implemented, and oversized histories fail visibly without resetting them. Folder membership in notes participates in CRDT merging; the separate empty-folder registry is a snapshot and concurrent changes to that registry may need reconciliation. Publication/deletion span multiple Pubky files and are ordered rather than atomic.

IndexedDB persistence protects reloads and temporary outages, but clearing site data or losing the device can erase changes that have not reached the homeserver. Keep exports of important notes. A temporary homeserver failure does not erase local drafts or the pending upload queue.

## Vercel

`vercel.json` configures the Vite build, SPA routing, ICE configuration endpoint, and browser security headers. The default deployment needs no application database or server secrets: browsers connect to Pubky and use its public HTTP relay for encrypted collaboration introductions. Reliable connections across restrictive networks additionally use Cloudflare TURN with server-side credentials and a Vercel Firewall rate limit; this path needs no Redis database. Enable and verify the firewall rule before selecting `COLLABORATION_TURN_RATE_LIMIT=vercel`. An optional Redis limiter remains available for globally shared issuance limits. See [collaboration hosting](docs/collaboration-hosting.md) for setup and verification.

```sh
vercel deploy --prod
```

Public snapshot links use `/pubky<owner>/pub/notes/<id>.json`. Older `/?owner=<z32-public-key>&note=<note-id>` links still open the public snapshot. Note paths support direct visits, reloads, and browser Back/Forward navigation. Missing or inaccessible targets show an explicit state rather than opening a different note.

## Two-person collaboration

Connect Pubky, open a note, choose **Collaborate → Create shared copy**, and send the invitation link. The original note remains unchanged. The shared copy begins with only the current visible title and Markdown, so old deleted private text is not included. The other person signs in, opens the invitation, and chooses **Join collaboration**. The compact panel below the editor toolbar shows the invitation and incoming approval request without opening another dialog or interrupting typing. Review the cryptographically verified Pubky identifier before choosing **Allow collaborator**. The app fetches the public profile itself and checks your follows, warning when you do not follow the requester. A failed follow lookup is shown as unknown; names and photos are recognition aids, not unique identifiers. The panel closes once connected; **Collaborate** or the footer status opens it again.

Each participant edits the same Yjs document through an ordered WebRTC data channel and independently saves the complete merged document under `/priv/notes/<id>.json` on their own homeserver. Folder changes and Trash belong only to that person's copy. Publication remains a separate, explicit action. The footer's **Peer received** means that peer acknowledged local device persistence; the existing **Saved to Pubky** status describes your own homeserver.

While both people edit the shared Markdown, a colored cursor and selection show where the other person is working. Positions follow the text as concurrent edits merge. The label uses the participant's shared profile display name when available, with a browser connection code as fallback; a name is not verified Pubky identity. Cursor presence is temporary, clears when the participant leaves the editor, and is never saved in a note or sent to a homeserver. Both browsers must support the current collaboration handshake.

Connection identity uses SDK custom proofs of possession: the root-signed grant authenticates a delegated key, which signs a fresh challenge bound to both browser keys, sessions, roles, the app/network, and the complete shared-note identity. Both sides verify before admission or document exchange, and reconnects retain the admitted Pubky identity. Proofs stay in encrypted signaling and are never stored in notes. Grant expiry bounds the connection lifetime; the SDK verifies signatures and expiry offline, without querying homeserver revocation. Peer avatars are restricted to public Pubky resources belonging to the verified identity. Sessions without grant proof support must sign in again.

Shared-note History opens a Changes view showing each editor’s additions and removals, including title changes and deletions of another person’s text. Attribution is recorded with each operation and survives offline merges, forwarding, and reloads; a saved version can contain multiple contributors. Names and public author IDs are supplied by participants, not independently verified account identity. The Preview view shows the complete saved text. The shared edit journal starts with the fresh collaboration copy; original private operations and private checkpoint lists are never sent to the collaborator.

Both browsers must be online together to exchange changes. Offline changes remain in the local outbox and merge when the connection returns. An invitation opened before sign-in survives login, navigation, and reload in the same tab for up to 24 hours; joining still requires an explicit click. Pending invitations are network-bound and kept in tab-scoped session storage until joined or dismissed. Reloading an established collaboration on the same browser/account reuses the locally stored invitation and admitted browser keys. Collaboration keys are separate from Pubky sessions and are kept in account-scoped IndexedDB; clearing site data removes those connection credentials. Signing out closes the peer connection. **Details → Disconnect collaboration** pauses live exchange while retaining both copies.

Invitation secrets live in the URL fragment and are removed from the address bar after opening. Signaling is encrypted and signed with a pinned host key, and a host admits only one guest browser key. The peer receives validated, bounded title/content operations and their edit attribution, never Pubky sessions, personal checkpoints, folder/Trash metadata, or publication commands. These are trusted-editor collaborations: an admitted editor can change or delete shared text and retain previously received content.

See [collaboration hosting](docs/collaboration-hosting.md) for signaling, TURN relay configuration, connectivity limits, and optional self-hosting. TURN availability is shown under **Details** in the collaboration panel. Live collaboration requires browser WebRTC support; Tor Browser intentionally does not provide it. Unsupported browsers are detected before a shared copy is created, and an unanswered connection handshake is distinguished from an ICE connectivity failure. If connection attempts fail, an inline message explains the problem and offers **Retry connection**. The CLI can read and edit version 2 documents, but does not yet join live peer connections.

## Verification

```sh
npm test                    # Entire offline test suite
npm run test:crdt            # CRDT, durable storage, sync, and relevant UI tests
npm run test:crdt:mutations  # Prove the new tests detect six deliberate defects
npm run build               # TypeScript and production bundle
npm run test:collaboration   # Shared document, invitation, transport and framing tests
npm run test:collaboration:infrastructure # Signaling and relay-credential API tests
npm run test:collaboration:browser # Actual two-browser WebRTC + local Pubky testnet
```

The browser suite requires the local Pubky testnet described below, Playwright Chromium (`npx playwright install chromium`), and the disposable TURN fixture running in another terminal:

```sh
node scripts/collaboration/start-local-turn.mjs
```

It uses two separate disposable Pubky accounts and checks real private homeserver files. Cases cover admission, concurrent edits, personal folders and publication, logout, offline merging, reload, and actual relay-to-relay traffic with the initial handshake deliberately dropped. The default test discovery service runs locally. To check the existing public Pubky relay as well, run `COLLAB_E2E_SIGNAL_URL=https://httprelay.pubky.app/inbox/ npx playwright test -g 'approved browsers'`. No personal sessions or notes are used.

Convergence tests run four independent replicas through five editing rounds under four seeded delivery schedules. Every packet crosses a JSON serialization boundary; delivery includes duplicates, stale states, and different ordering. An independent ledger checks for lost insertions and resurrected deletions after each delivery, and the final text is checked against an expected document built from user actions. Additional cases cover overlapping edits, Unicode and Markdown, folder/title changes, deletion, and explicit restoration.

Storage integration tests run the actual cache, synchronization, note serialization, and SDK address parsing together. Only the transport is simulated, with serialized files and session-owned exclusive locks. They cover independent device caches, lock contention, a committed write whose response is lost, restarts, late acknowledgements, history recovery, and public snapshot privacy. The mutation command copies the project into a temporary directory and verifies that dropping remote updates, replacing whole texts, discarding pending edits, bypassing recovery, and leaking private or unreviewed content cause test failures. It never changes working-tree source files.

Cross-project checks require the current CLI checkout at `../pubky-notes-cli`, with its dependencies installed. These commands build that checkout and exercise its actual implementation in a separate process, rather than relying only on a frozen compatibility fixture:

```sh
npm --prefix ../pubky-notes-cli ci
npm run test:interop         # Current web/CLI history exchange; no network
npm run test:homeserver      # Explicit local-testnet integration; real SDK/storage
```

The homeserver test uses only `Pubky.testnet('127.0.0.1')`, creates a random disposable identity, and never loads Ring credentials or existing notes. It fails if the local testnet is unavailable. It verifies real locks, read-back, web/CLI merging, revision conflicts, publication privacy, and deletion/restoration, then removes its generated files and signs out its test sessions. Ordinary `npm test` does not contact a homeserver.

If a local testnet is not already running, the image verified with SDK 0.16.1 can be started separately:

```sh
docker run --rm --name pubky-notes-testnet \
  -p 127.0.0.1:6286-6288:6286-6288 \
  -p 127.0.0.1:15411-15412:15411-15412 \
  synonymsoft/homeserver-testnet@sha256:4e404fee8b11b87642eb61cd055620e07c76947ab5bf149e20feb84f44a6c0f8
```

The broader suite also covers account isolation and guest adoption, editor saves, folder operations, authorization, pagination, and bounded downloads. Mainnet Ring approval remains a separate manual check; automated tests do not use a user's account.

The SDK version is pinned to 0.16.1. Some linked Pubky agent-skill references target earlier SDK versions; implementation follows installed types and the current template.

## Credits

Pubky authentication lifecycle patterns are adapted from the MIT-licensed Pubky app template; its license is retained in `THIRD_PARTY_LICENSES.md`.
