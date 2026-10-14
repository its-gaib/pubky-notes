const MAX_FOLDER_LENGTH = 512
const MAX_FOLDER_DEPTH = 8
const MAX_SEGMENT_LENGTH = 80

/** Folder names are private metadata; they never determine a storage URL. */
export function normalizeFolder(input: string): string {
  if (typeof input !== 'string' || /[\\\u0000-\u001f\u007f-\u009f]/u.test(input)) {
    throw new Error('Folder names cannot contain backslashes or control characters.')
  }
  const trimmed = input.trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed) return ''
  const segments = trimmed.split('/').map((segment) => segment.trim())
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Folder names cannot be empty, ".", or "..". Separate names with a single slash.')
  }
  const path = segments.join('/')
  if (path.length > MAX_FOLDER_LENGTH || segments.length > MAX_FOLDER_DEPTH ||
      segments.some((segment) => segment.length > MAX_SEGMENT_LENGTH)) {
    throw new Error('Folder paths can have up to 8 levels, 80 characters per name, and 512 characters total.')
  }
  return path
}

export function folderPaths(
  records: readonly { note: { folder?: string } }[],
  explicitFolders: readonly string[] = [],
): string[] {
  const paths = new Set<string>()
  for (const input of [...explicitFolders, ...records.map(({ note }) => note.folder ?? '')]) {
    const folder = normalizeFolder(input)
    if (!folder) continue
    const segments = folder.split('/')
    for (let depth = 1; depth <= segments.length; depth++) paths.add(segments.slice(0, depth).join('/'))
  }
  return [...paths].sort((a, b) => a.localeCompare(b))
}

export function folderContains(parent: string, path: string): boolean {
  const normalizedParent = normalizeFolder(parent)
  const normalizedPath = normalizeFolder(path)
  return normalizedPath === normalizedParent ||
    (normalizedParent !== '' && normalizedPath.startsWith(`${normalizedParent}/`))
}

export function folderLabel(path: string): string {
  return normalizeFolder(path).split('/').at(-1) ?? ''
}

export function filterNotes<T extends {
  note: { title: string; content: string; folder?: string }
  published: unknown
}>(
  records: readonly T[],
  query: string,
  visibility: 'all' | 'private' | 'public',
  folder: string | null,
): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  if (tokens.length) {
    return records.filter(({ note }) => {
      const searchable = `${note.title}\n${note.content}`.toLowerCase()
      return tokens.every((token) => searchable.includes(token))
    })
  }
  return records.filter((record) =>
    (visibility === 'all' || (visibility === 'public' ? Boolean(record.published) : !record.published)) &&
    (folder === null || folderContains(folder, record.note.folder ?? '')),
  )
}

export function renameFolderPath(current: string, source: string, target: string): string {
  const path = normalizeFolder(current)
  const from = normalizeFolder(source)
  const to = normalizeFolder(target)
  if (!from) throw new Error('Choose a named folder to rename.')
  if (!folderContains(from, path)) return path
  const suffix = path.slice(from.length).replace(/^\//, '')
  return normalizeFolder([to, suffix].filter(Boolean).join('/'))
}
