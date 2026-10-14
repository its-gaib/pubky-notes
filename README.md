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

The checked-in `.env` selects **Pubky mainnet**. Sign in with an existing identity in **Pubky Ring** using the QR code, phone link, or copyable authorization link. The app never requests a secret key or creates a mainnet identity. Until connected, the sample notebook is an in-memory scratchpad; it is not uploaded or retained after reload. Connecting replaces the scratchpad with the signed-in notebook. Export drafts first if needed.

For a separately running local testnet, copy `.env.example` to `.env.local`, set `VITE_PUBKY_TESTNET=true`, and configure `VITE_PUBKY_TESTNET_HOST` if necessary. The default testnet relay uses port 15412. The production Vercel headers intentionally allow HTTPS connections; use Vite locally for the HTTP testnet. Production uses the SDK’s default auth relay unless `VITE_PUBKY_HTTP_RELAY` is configured.

## Storage and sharing

- Canonical notes: `/priv/notes/<id>.json`.
- Explicit public snapshots: `/pub/notes/<id>.json`.
- Records contain `id`, `title`, `content`, `createdAt`, and `updatedAt`. Nested folders exist only as optional private `folder` metadata, such as `Work/Ideas`; all files remain directly under their storage root. Public snapshots omit folder metadata. Moving a note between folders does not change its ID or public link.
- During migration, the app requests read/write access to exactly four roots: `/priv/notes/`, `/pub/notes/`, `/priv/notes.pubky.app/notes/`, and `/pub/notes.pubky.app/notes/`. The stable authentication client ID remains `notes.pubky.app`; it no longer determines storage paths.
- New notes and edits autosave to `/priv`. Publishing first saves the private draft, then writes a public snapshot. Later edits remain private until **Update public copy** is clicked.
- A public link opens a read-only Markdown page without authentication. Public notes are publicly readable and discoverable, not secret links.
- Unpublish removes public snapshots from both current and legacy roots. Deleting a note removes both public copies before its private copies; failures are reported. Unpublishing cannot retract copies already downloaded.
- Pubky `/priv` restricts access but **is not end-to-end encrypted**. The homeserver operator can read it. See the [private storage contract](https://pubky.org/private-storage.md).

Existing accounts must reconnect once to authorize the new paths. On connection, legacy private drafts and public snapshots migrate independently, so unpublished edits stay private. Migration locks both paths, verifies the destination before removing the source, and resumes safely after interruptions. Conflicting versions are preserved and reported rather than overwritten. Homeservers without storage-lock support retain the original files and report that migration requires an upgrade. Public links try the new path first and fall back to the legacy path only when the new file is missing.

Authentication uses scoped Pubky Ring grant sessions. SDK-managed IndexedDB stores session credentials; localStorage contains the opaque session record ID and sidebar layout preferences. Note bodies are not cached in localStorage or IndexedDB. Markdown raw HTML is disabled; remote images render as text to avoid tracking readers.

## Features and boundaries

Search across all note titles and Markdown content, nested folders, Markdown editing/preview with GFM tables and task lists, formatting tools, `.md` import/export, explicit publish/update/unpublish, and responsive navigation. New notes start with the concise Markdown sample as a template; imported files retain their own content. Search covers the entire notebook regardless of the selected folder or visibility filter. Use Ctrl/⌘+S to save immediately.

Click the folder name below a note to move it. Enter a path such as `Work/Ideas` to create nested folders, or leave it blank for Unfiled. New notes inherit the selected folder. Folders are derived from notes and disappear when empty.

Notes are limited to 250,000 content characters / 512 KiB serialized, titles to 200 characters, and each private/public folder to 2,000 entries. Imports accept files up to 512 KiB and must also satisfy the note limits when saving. Lists paginate; note downloads are bounded and use limited concurrency.

Use one editing tab per notebook. Concurrent device edits use last-writer-wins; this version does not merge conflicts or keep history. There is no offline note cache. If a save fails, keep the tab open and retry or export the note. Changes to publication and deletion are ordered but cannot be atomic across multiple Pubky objects.

## Vercel

`vercel.json` configures the Vite build, SPA routing and browser security headers. No server secrets or application database are needed: the browser connects directly to Pubky.

```sh
vercel deploy --prod
```

Public links use `/?owner=<z32-public-key>&note=<note-id>`.

## Verification

`npm test` exercises flat scoped paths, private folder metadata, global search, migration retries and conflicts, authorization upgrades, publishing and cleanup, untrusted data, pagination and bounded downloads. `npm run build` checks TypeScript and creates the production bundle. A live Ring approval and your homeserver are needed to verify an existing mainnet account end to end.

The SDK version is pinned to 0.16.1. Some linked Pubky agent-skill references target earlier SDK versions; implementation follows installed types and the current template.

## Credits

Pubky authentication lifecycle patterns are adapted from the MIT-licensed Pubky app template; its license is retained in `THIRD_PARTY_LICENSES.md`.
