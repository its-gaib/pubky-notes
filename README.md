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

- Canonical notes: `/priv/notes.pubky.app/notes/<id>.json`.
- Explicit public snapshots: `/pub/notes.pubky.app/notes/<id>.json`.
- Records contain `id`, `title`, `content`, `createdAt`, and `updatedAt`.
- The app requests read/write capabilities only for those two note folders.
- New notes and edits autosave to `/priv`. Publishing first saves the private draft, then writes a public snapshot. Later edits remain private until **Update public copy** is clicked.
- A public link opens a read-only Markdown page without authentication. Public notes are publicly readable and discoverable, not secret links.
- Unpublish removes the public snapshot. Deleting a note removes its public snapshot before its private original; failures are reported. Unpublishing cannot retract copies already downloaded.
- Pubky `/priv` restricts access but **is not end-to-end encrypted**. The homeserver operator can read it. See the [private storage contract](https://pubky.org/private-storage.md).

Authentication uses scoped Pubky Ring grant sessions. SDK-managed IndexedDB stores session credentials; localStorage contains only the opaque session record ID. Note bodies are not cached in localStorage or IndexedDB. Markdown raw HTML is disabled; remote images render as text to avoid tracking readers.

## Features and boundaries

Search, Markdown editing/preview with GFM tables and task lists, formatting tools, `.md` import/export, explicit publish/update/unpublish, and responsive navigation. Use Ctrl/⌘+S to save immediately.

Notes are limited to 250,000 content characters / 512 KiB serialized, titles to 200 characters, and each private/public folder to 2,000 entries. Imports accept files up to 512 KiB and must also satisfy the note limits when saving. Lists paginate; note downloads are bounded and use limited concurrency.

Use one editing tab per notebook. Concurrent device edits use last-writer-wins; this version does not merge conflicts or keep history. There is no offline note cache. If a save fails, keep the tab open and retry or export the note. Changes to publication and deletion are ordered but cannot be atomic across two Pubky objects.

## Vercel

`vercel.json` configures the Vite build, SPA routing and browser security headers. No server secrets or application database are needed: the browser connects directly to Pubky.

```sh
vercel deploy --prod
```

Public links use `/?owner=<z32-public-key>&note=<note-id>`.

## Verification

`npm test` exercises scoped paths, private saves, explicit publishing, failed deletion, orphan recovery, untrusted listing entries, pagination, malformed data and bounded downloads. `npm run build` checks TypeScript and creates the production bundle. A live Ring approval and your homeserver are needed to verify an existing mainnet account end to end.

The SDK version is pinned to 0.16.1. Some linked Pubky agent-skill references target earlier SDK versions; implementation follows installed types and the current template.

## Credits

Pubky authentication lifecycle patterns are adapted from the MIT-licensed Pubky app template; its license is retained in `THIRD_PARTY_LICENSES.md`.
