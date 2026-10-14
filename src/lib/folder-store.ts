import type { Path, Session } from '@synonymdev/pubky'
import { APP_PATHS } from '../config'
import { normalizeFolder } from './folders'

// This private metadata file has no .json suffix, so note readers skip it.
export const FOLDERS_PATH: Path = `${APP_PATHS.private}folders`
export const MAX_FOLDERS = 2_000
export const MAX_FOLDER_STORE_BYTES = 256 * 1024

export async function loadFolders(session: Session): Promise<string[]> {
  try {
    const value = await readFolderStore(await session.storage.get(FOLDERS_PATH))
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        !('version' in value) || value.version !== 1 || !('folders' in value)) {
      throw new Error('The homeserver returned invalid folder metadata.')
    }
    return normalizeFolderPaths(value.folders)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

export async function saveFolders(session: Session, folders: readonly string[]): Promise<string[]> {
  const saved = normalizeFolderPaths(folders)
  const value = { version: 1, folders: saved }
  await session.storage.putJson(FOLDERS_PATH, value)
  return saved
}

/** Validate a complete registry before beginning a multi-file folder operation. */
export function normalizeFolderPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_FOLDERS) {
    throw new Error(`Folder metadata must contain at most ${MAX_FOLDERS.toLocaleString()} folder names.`)
  }
  const folders = value.map((entry: unknown) => {
    if (typeof entry !== 'string') throw new Error('Invalid folder name in folder metadata.')
    const folder = normalizeFolder(entry)
    if (!folder) throw new Error('Folder metadata cannot contain an empty folder name.')
    return folder
  })
  const saved = [...new Set(folders)].sort((a, b) => a.localeCompare(b))
  if (new TextEncoder().encode(JSON.stringify({ version: 1, folders: saved })).byteLength > MAX_FOLDER_STORE_BYTES) {
    throw new Error('The folder list is too large to save.')
  }
  return saved
}

async function readFolderStore(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel()
    throw Object.assign(new Error(`Folders could not be loaded (HTTP ${response.status}).`), {
      data: { statusCode: response.status },
    })
  }
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_FOLDER_STORE_BYTES) {
    await response.body?.cancel()
    throw new Error('The folder list is too large to open.')
  }
  if (!response.body) throw new Error('The homeserver returned empty folder metadata.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_FOLDER_STORE_BYTES) throw new Error('The folder list is too large to open.')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  try { return JSON.parse(text) } catch { throw new Error('The homeserver returned invalid folder metadata.') }
}

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false
  const data = error.data
  return typeof data === 'object' && data !== null && 'statusCode' in data &&
    (data.statusCode === 404 || data.statusCode === 410)
}
