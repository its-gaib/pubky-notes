import { normalizeFolderPaths } from './folder-store'
import { folderContains, folderLabel, folderPaths, normalizeFolder, renameFolderPath } from './folders'

interface FolderRecord { note: { id: string; folder?: string; deleted?: boolean } }
export interface FolderRelocation {
  source: string
  target: string
  folders: string[]
  stagedFolders: string[]
  moves: { id: string; from: string; to: string }[]
}

/** A folder dropped at the root keeps its name; it is not dissolved. */
export function folderMoveTarget(source: string, parent: string): string {
  const from = normalizeFolder(source), destination = normalizeFolder(parent)
  if (!from) throw new Error('Choose a named folder to move.')
  if (folderContains(from, destination)) throw new Error('A folder cannot be moved into itself or its subfolders.')
  return normalizeFolder([destination, folderLabel(from)].filter(Boolean).join('/'))
}

/** Validate the whole operation before any registry or note is changed. */
export function planFolderRelocation(
  records: readonly FolderRecord[],
  explicit: readonly string[],
  source: string,
  target: string,
  options: { resume?: boolean } = {},
): FolderRelocation {
  const from = normalizeFolder(source), to = normalizeFolder(target)
  if (!from || !to) throw new Error('Choose a named source and destination folder.')
  if (from === to) throw new Error('The folder is already there.')
  if (folderContains(from, to)) throw new Error('A folder cannot be moved into itself or its subfolders.')
  const current = folderPaths(records.filter(row => !row.note.deleted), explicit)
  if (!current.includes(from)) throw new Error('The source folder is no longer available.')
  const parent = to.split('/').slice(0, -1).join('/')
  if (parent && !current.includes(parent)) throw new Error('The destination folder is no longer available.')
  // Only a caller holding its own scoped, unfinished operation may resume a
  // destination it staged earlier. Ordinary moves never merge existing trees.
  if (current.includes(to) && !options.resume) throw new Error('A folder with that name already exists here.')
  const folders = normalizeFolderPaths(current.map(path => renameFolderPath(path, from, to)))
  const stagedFolders = normalizeFolderPaths([...current, ...folders])
  // Include Trash so restoring a note does not revive an obsolete path. Return
  // only folder patches: callers must read the current note before each write.
  const moves = records.flatMap(({ note }) => {
    const original = normalizeFolder(note.folder ?? '')
    return folderContains(from, original)
      ? [{ id: note.id, from: original, to: renameFolderPath(original, from, to) }]
      : []
  })
  return { source: from, target: to, folders, stagedFolders, moves }
}

/** A visible child folder counts as content, even when it has no notes. */
export function isEmptyFolder(path: string, records: readonly FolderRecord[], explicit: readonly string[]): boolean {
  const folder = normalizeFolder(path)
  if (!folder) return false
  const live = records.filter(row => !row.note.deleted)
  const paths = folderPaths(live, explicit)
  return paths.includes(folder)
    && !live.some(({ note }) => folderContains(folder, note.folder ?? ''))
    && !paths.some(candidate => candidate !== folder && folderContains(folder, candidate))
}
