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
- Records contain `id`, `title`, `content`, `createdAt`, and `updatedAt`, plus a private Yjs `crdt` envelope and optional `folder` / `deleted` metadata. Nested folders remain logical paths such as `Work/Ideas`; all files stay directly under their storage root. Empty folders are recorded separately at `/priv/notes/folders`. Public snapshots contain only the five public note fields. Moving a note does not change its ID or public link.
- Pubky Ring shows the authentication client ID `pubky-notes`. The app requests read/write access to exactly two roots: `/priv/notes/` and `/pub/notes/`.
- The account row reads your public name and avatar from `/pub/pubky.app/profile.json`, following [Pubky App Specs](https://github.com/pubky/pubky-app-specs/blob/main/SPEC.md#pubkyappuser). Click the abbreviated identifier to copy your complete `pubky…` identifier. Profile reads require no additional permissions; a missing profile or image falls back without blocking your notebook.
- Edits save locally first, then synchronize to `/priv`. The app distinguishes device storage from verified homeserver storage. Publishing saves the private draft and writes the specific text reviewed when Publish was clicked; newly merged remote private text is not silently published. Later edits remain private until **Update public copy** is clicked.
- A public link opens a read-only Markdown page without authentication. Public notes are publicly readable and discoverable, not secret links.
- Unpublish removes the public snapshot. Delete removes the public snapshot and records a private CRDT deletion marker. Trash retains the note and concurrent offline edits; Restore makes it visible again without republishing. This is recoverable deletion, not secure erasure. Unpublishing cannot retract copies already downloaded.
- Pubky `/priv` restricts access but **is not end-to-end encrypted**. The homeserver operator can read it. See the [private storage contract](https://pubky.org/private-storage.md).

Authentication uses scoped Pubky Ring grant sessions. SDK-managed IndexedDB stores session credentials separately from the app’s account-scoped note cache and upload outbox. LocalStorage contains the opaque session record ID, last account identifier, and sidebar layout preferences. Private note text and editing history are stored on this device and on the homeserver. Markdown raw HTML is disabled; remote images in notes render as text to avoid tracking readers.

## Features and boundaries

Search across all note titles and Markdown content, nested folders, Markdown editing/preview with GFM tables and task lists, formatting tools, `.md` import/export, explicit publish/update/unpublish, and responsive navigation. New notes start with the concise Markdown sample as a template; imported files retain their own content. Search covers the entire notebook regardless of the selected folder or visibility filter. Use Ctrl/⌘+S to save immediately.

Use **New folder** in the navigation sidebar. Each folder’s menu offers New subfolder, Rename, and Remove empty folder; renaming also moves its descendants. Each note’s sidebar menu offers **Move to…**, with existing destinations, Unfiled, or a new path. New notes inherit the selected folder. Empty folders persist; removing a folder never implicitly deletes its notes.

Notes are limited to 250,000 content characters / 4 MiB serialized including CRDT history, titles to 200 characters, and each private/public root to 2,000 entries. Imports accept files up to 512 KiB and must also satisfy the note limits when saving. Lists paginate; note downloads are bounded and use limited concurrency.

The browser and CLI use compatible [Yjs updates](https://docs.yjs.dev/api/document-updates). Text edits become incremental operations. Each private save locks the note, merges remote history, writes the result, and reads it back before acknowledging the upload. Failed writes remain queued locally; background refresh and reconnection reconcile cached and remote states. Incompatible histories are retained as separate recovery copies, and later edits from stale tabs follow their own recovered history. Publishing after recovery requires a fresh publish action on the recovered note. The CLI still requires a current revision before changing a note.

Concurrent edits converge, but overlapping prose can need human cleanup. CRDT history retains earlier private text; no automatic compaction or permanent purge is implemented, and oversized histories fail visibly without resetting them. Folder membership in notes participates in CRDT merging; the separate empty-folder registry is a snapshot and concurrent changes to that registry may need reconciliation. Publication/deletion span multiple Pubky files and are ordered rather than atomic.

IndexedDB persistence protects reloads and temporary outages, but clearing site data or losing the device can erase changes that have not reached the homeserver. Keep exports of important notes. A temporary homeserver failure does not erase local drafts or the pending upload queue.

## Vercel

`vercel.json` configures the Vite build, SPA routing and browser security headers. No server secrets or application database are needed: the browser connects directly to Pubky.

```sh
vercel deploy --prod
```

Public links use `/?owner=<z32-public-key>&note=<note-id>`.

## Verification

`npm test` exercises CRDT convergence and validation, scoped durable caches and guest adoption, in-flight saves, folder operations, recovery and Trash, public snapshot privacy, scoped authorization, pagination, and bounded downloads. `npm run build` checks TypeScript and creates the production bundle. A live Ring approval and your homeserver are needed to verify a mainnet account end to end.

The SDK version is pinned to 0.16.1. Some linked Pubky agent-skill references target earlier SDK versions; implementation follows installed types and the current template.

## Credits

Pubky authentication lifecycle patterns are adapted from the MIT-licensed Pubky app template; its license is retained in `THIRD_PARTY_LICENSES.md`.
