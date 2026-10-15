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
- Records contain `id`, `title`, `content`, `createdAt`, and `updatedAt`, plus a private Yjs `crdt` envelope and optional `folder` / `deleted` metadata. Ordinary notes retain CRDT version 1. Collaborative notes use version 2: `update` contains shared title/content and `personal` contains the account's separate folder/Trash history. Nested folders remain logical paths such as `Work/Ideas`; all files stay directly under their storage root. Empty folders are recorded separately at `/priv/notes/folders`. Public snapshots contain only the five public note fields. Moving a note does not change its ID or public link.
- Pubky Ring shows the authentication client ID `pubky-notes`. The app requests read/write access to exactly two roots: `/priv/notes/` and `/pub/notes/`.
- The account row reads your public name and avatar from `/pub/pubky.app/profile.json`, following [Pubky App Specs](https://github.com/pubky/pubky-app-specs/blob/main/SPEC.md#pubkyappuser). Click the abbreviated identifier to copy your complete `pubky…` identifier. Profile reads require no additional permissions; a missing profile or image falls back without blocking your notebook.
- Edits save locally first, then synchronize to `/priv`. The app distinguishes device storage from verified homeserver storage. Publishing saves the private draft and writes the specific text reviewed when Publish was clicked; newly merged remote private text is not silently published. Later edits remain private until **Update public copy** is clicked.
- A public link opens a read-only Markdown page without authentication. Public notes are publicly readable and discoverable, not secret links.
- Each saved note has a stable editor URL, `/pubky<owner>/priv/notes/<id>.json`, even when it also has a published copy. Opening a private link requires that owner's connected account; the link does not grant access or publish the note. **Copy note link** copies it and briefly explains that sharing with other people requires publishing a public copy. Guest drafts use `/local/notes/<id>.json`, which works only with that browser's local notebook; signing in updates the address to the adopted note's private path.
- Unpublish removes the public snapshot. Delete removes the public snapshot and records a private CRDT deletion marker. Trash retains the note and concurrent offline edits; Restore makes it visible again without republishing. This is recoverable deletion, not secure erasure. Unpublishing cannot retract copies already downloaded.
- Pubky `/priv` restricts access but **is not end-to-end encrypted**. The homeserver operator can read it. See the [private storage contract](https://pubky.org/private-storage.md).

Authentication uses scoped Pubky Ring grant sessions. SDK-managed IndexedDB stores session credentials separately from the app’s account-scoped note cache and upload outbox. LocalStorage contains the opaque session record ID, last account identifier, and sidebar layout preferences. Private note text and editing history are stored on this device and on the homeserver. Markdown raw HTML is disabled; remote images in notes render as text to avoid tracking readers.

## Features and boundaries

Search across all note titles and Markdown content, nested folders, Markdown editing/preview with GFM tables and task lists, formatting tools, `.md` import/export, explicit publish/update/unpublish, and responsive navigation. New notes start with the concise Markdown sample as a template; imported files retain their own content. Search covers the entire notebook regardless of the selected folder or visibility filter. Use Ctrl/⌘+S to save immediately.

Manage folders entirely in the sidebars. The navigation tree shows folders and their notes, including notes at the top level. **New folder** and **New subfolder** open an inline name field. Click a folder to select it, then click its name again to rename it; Enter saves and Escape cancels. The adjacent trash icon works only when there are no notes or child folders. Drag notes or folders onto a destination folder, or onto **All notes** to move them to the top level. Folder moves and renames include their descendants. The **Move to…** sidebar menus offer the same destinations for keyboard and touch use. New notes inherit the selected folder, empty folders persist, and moving items preserves note URLs and public snapshots.

On desktop, drag either sidebar's right border to resize it, or focus the border and use the arrow keys. The folder sidebar allows 160–360 px and the notes sidebar 200–480 px, constrained to leave at least 320 px for the editor. Preferred widths are remembered on this device and retained through collapsing or temporarily narrowing the window. Mobile keeps its compact layout.

Notes are limited to 250,000 content characters / 4 MiB serialized including CRDT history, titles to 200 characters, and each private/public root to 2,000 entries. Imports accept files up to 512 KiB and must also satisfy the note limits when saving. Lists paginate; note downloads are bounded and use limited concurrency.

The browser and CLI use compatible [Yjs updates](https://docs.yjs.dev/api/document-updates). Text edits become incremental operations. Each private save locks the note, merges remote history, writes the result, and reads it back before acknowledging the upload. Failed writes remain queued locally; background refresh and reconnection reconcile cached and remote states. Incompatible histories are retained as separate recovery copies, and later edits from stale tabs follow their own recovered history. Publishing after recovery requires a fresh publish action on the recovered note. The CLI still requires a current revision before changing a note.

Concurrent edits converge, but overlapping prose can need human cleanup. CRDT history retains earlier private text; no automatic compaction or permanent purge is implemented, and oversized histories fail visibly without resetting them. Folder membership in notes participates in CRDT merging; the separate empty-folder registry is a snapshot and concurrent changes to that registry may need reconciliation. Publication/deletion span multiple Pubky files and are ordered rather than atomic.

IndexedDB persistence protects reloads and temporary outages, but clearing site data or losing the device can erase changes that have not reached the homeserver. Keep exports of important notes. A temporary homeserver failure does not erase local drafts or the pending upload queue.

## Vercel

`vercel.json` configures the Vite build, SPA routing, ICE configuration endpoint, and browser security headers. The default deployment needs no application database or server secrets: browsers connect to Pubky and use its public HTTP relay for encrypted collaboration introductions. A production TURN provider needs separate configuration as described below.

```sh
vercel deploy --prod
```

Public snapshot links use `/pubky<owner>/pub/notes/<id>.json`. Older `/?owner=<z32-public-key>&note=<note-id>` links still open the public snapshot. Note paths support direct visits, reloads, and browser Back/Forward navigation. Missing or inaccessible targets show an explicit state rather than opening a different note.

## Two-person collaboration

Connect Pubky, open a note, choose **Collaborate → Create shared copy**, and send the invitation link. The original note remains unchanged. The shared copy begins with only the current visible title and Markdown, so old deleted private text is not included. The other person signs in, opens the invitation, and chooses **Join collaboration**. Compare their displayed connection code before choosing **Allow collaborator**. The code authenticates a browser key; it does not verify a Pubky profile identity.

Each participant edits the same Yjs document through an ordered WebRTC data channel and independently saves the complete merged document under `/priv/notes/<id>.json` on their own homeserver. Folder changes and Trash belong only to that person's copy. Publication remains a separate, explicit action. The footer's **Peer received** means that peer acknowledged local device persistence; the existing **Saved to Pubky** status describes your own homeserver.

While both people edit the shared Markdown, a colored cursor and selection show where the other person is working. Positions follow the text as concurrent edits merge. The label uses the participant's shared profile display name when available, with a browser connection code as fallback; a name is not verified Pubky identity. Cursor presence is temporary, clears when the participant leaves the editor, and is never saved in a note or sent to a homeserver. Both browsers need a version that supports cursors; older versions can still exchange text.

Both browsers must be online together to exchange changes. Offline changes remain in the local outbox and merge when the connection returns. Reloading on the same browser/account reuses the locally stored invitation and admitted browser keys. Collaboration keys are separate from Pubky sessions and are kept in account-scoped IndexedDB; clearing site data removes those connection credentials. Signing out closes the peer connection. **Disconnect collaboration** pauses live exchange while retaining both copies.

Invitation secrets live in the URL fragment and are removed from the address bar after opening. Signaling is encrypted and signed with a pinned host key, and a host admits only one guest browser key. The peer receives only validated, bounded title/content updates, never Pubky sessions, personal metadata, or publication commands. These are trusted-editor collaborations: an admitted editor can change or delete shared text and retain previously received content.

See [collaboration hosting](docs/collaboration-hosting.md) for signaling, TURN relay configuration, connectivity limits, and optional self-hosting. TURN availability is shown honestly in the collaboration dialog. The CLI can read and edit version 2 documents, but does not yet join live peer connections.

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
