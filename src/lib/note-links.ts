import { PublicKey } from '@synonymdev/pubky'

export type NoteRoute =
  | { kind: 'home' }
  | { kind: 'local'; id: string }
  | { kind: 'private' | 'public'; owner: string; id: string }
  | { kind: 'invalid' }

const ID = /^[a-zA-Z0-9_-]{1,80}$/
const OWNER = /^(?:pubky)?[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/

function requireId(id: string): string {
  if (!ID.test(id)) throw new Error('Invalid note identifier.')
  return id
}

function canonicalOwner(owner: string): string {
  // PublicKey.from also accepts complete addresses. A route owner must be
  // exactly an identifier, never an address containing another storage path.
  if (!OWNER.test(owner)) throw new Error('Invalid Pubky identifier.')
  const key = PublicKey.from(owner)
  try { return key.z32() } finally { key.free() }
}

/** Parse only known note routes. A URL selects a note; it never grants access. */
export function parseNoteRoute(location: Pick<Location, 'pathname' | 'search'>): NoteRoute {
  const { pathname, search } = location
  const params = new URLSearchParams(search)
  try {
    if (pathname === '/') {
      if (!params.has('owner') && !params.has('note')) return { kind: 'home' }
      // Older links remain public-only. Ambiguous parameters are rejected.
      if (params.getAll('owner').length !== 1 || params.getAll('note').length !== 1) return { kind: 'invalid' }
      return { kind: 'public', owner: canonicalOwner(params.get('owner')!), id: requireId(params.get('note')!) }
    }
    if (params.has('owner') || params.has('note')) return { kind: 'invalid' }
    const local = /^\/local\/notes\/([a-zA-Z0-9_-]{1,80})\.json$/.exec(pathname)
    if (local) return { kind: 'local', id: local[1] }
    // Do not decode path components: encoded slashes, dots and extra segments
    // must not turn into a different storage location.
    const stored = /^\/([^/]+)\/(priv|pub)\/notes\/([a-zA-Z0-9_-]{1,80})\.json$/.exec(pathname)
    if (!stored) return { kind: 'invalid' }
    return { kind: stored[2] === 'priv' ? 'private' : 'public', owner: canonicalOwner(stored[1]), id: stored[3] }
  } catch { return { kind: 'invalid' } }
}

export function notePath(owner: string | null, id: string, visibility: 'priv' | 'pub' = 'priv'): string {
  requireId(id)
  if (visibility !== 'priv' && visibility !== 'pub') throw new Error('Invalid note visibility.')
  if (owner === null) {
    if (visibility !== 'priv') throw new Error('Local notes do not have a public address.')
    return `/local/notes/${id}.json`
  }
  return `/pubky${canonicalOwner(owner)}/${visibility}/notes/${id}.json`
}

export function noteUrl(owner: string | null, id: string, visibility: 'priv' | 'pub' = 'priv', origin = window.location.origin): string {
  return new URL(notePath(owner, id, visibility), origin).href
}
