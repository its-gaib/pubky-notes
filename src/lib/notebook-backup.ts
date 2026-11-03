import { initializeNote, MAX_CONTENT_LENGTH, MAX_NOTE_BYTES, validateCrdtNote, validateFields } from './crdt'
import type { Note, NoteRecord } from './notes'
import { normalizeFolder } from './folders'
import { normalizeFolderPaths } from './folder-store'

export const MAX_NOTEBOOK_IMPORT_BYTES = 32 * 1024 * 1024
export const MAX_NOTEBOOK_DECODED_BYTES = 64 * 1024 * 1024
export const MAX_NOTEBOOK_NOTES = 2_000
export const MAX_MARKDOWN_IMPORT_BYTES = 512 * 1024
const MAX_ARCHIVE_ENTRIES = 4_000
const FORMAT = 'pubky-notes-backup'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface NotebookExportSnapshot { records: readonly NoteRecord[]; folders: readonly string[] }
export interface BackupOptions { includeHistory: boolean; includeTrash: boolean }
export interface NotebookImportPlan {
  notes: Note[]
  folders: string[]
  source: 'backup' | 'markdown'
  fileCount: number
  totalBytes: number
  historyCount: number
  deletedCount: number
}
interface BackupDocument {
  format: typeof FORMAT
  version: 1
  exportedAt: string
  folders: string[]
  notes: Note[]
}

/** The export allowlist deliberately excludes sessions, public snapshots and
 * collaboration connection credentials. Historical private text is opt-in UI. */
export function createNotebookBackup(snapshot: NotebookExportSnapshot, options: BackupOptions = { includeHistory: true, includeTrash: false }): string {
  const selected = snapshot.records.filter(({ note }) => options.includeTrash || !note.deleted)
  if (selected.length > MAX_NOTEBOOK_NOTES) throw new Error('A backup can contain at most 2,000 notes, including Trash.')
  let totalBytes = 0
  const notes = selected.map(({ note }) => {
    const clean = cleanNote(note, options.includeHistory)
    totalBytes += encoder.encode(JSON.stringify(clean)).byteLength
    if (totalBytes > MAX_NOTEBOOK_IMPORT_BYTES) throw new Error('This backup exceeds 32 MiB. Export without version history or export smaller groups of Markdown files.')
    return clean
  })
  const document: BackupDocument = {
    format: FORMAT, version: 1, exportedAt: new Date().toISOString(),
    folders: completeFolders(snapshot.folders, notes), notes,
  }
  const json = JSON.stringify(document)
  if (encoder.encode(json).byteLength > MAX_NOTEBOOK_IMPORT_BYTES) throw new Error('This backup exceeds 32 MiB. Export without version history or export smaller groups of Markdown files.')
  return json
}

/** Portable ZIP files contain only current live Markdown and empty folders.
 * Restorable JSON backups are the format that retains exact metadata/history. */
export async function createMarkdownArchive(snapshot: NotebookExportSnapshot): Promise<Uint8Array<ArrayBuffer>> {
  const { zipSync } = await import('fflate')
  const records = snapshot.records.filter(({ note }) => !note.deleted)
  if (records.length > MAX_NOTEBOOK_NOTES) throw new Error('A Markdown archive can contain at most 2,000 notes.')
  const files: Record<string, Uint8Array> = Object.create(null)
  const folders = completeFolders(snapshot.folders, records.map(({ note }) => note))
  for (const folder of folders) { safeArchivePath(`${folder}/`); files[`${folder}/`] = new Uint8Array() }
  let total = 0
  const names = new Set<string>()
  for (const { note: value } of records) {
    const note = cleanNote(value, false)
    const slug = (note.title || 'Untitled note').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'note'
    const stem = `${note.folder ? `${note.folder}/` : ''}${slug}--${note.id.slice(0, 12)}`
    let path = `${stem}.md`, suffix = 2
    while (names.has(path.toLocaleLowerCase())) path = `${stem}-${suffix++}.md`
    names.add(path.toLocaleLowerCase()); safeArchivePath(path)
    const data = encoder.encode(`# ${note.title || 'Untitled note'}\n\n${note.content}`)
    if (data.byteLength > MAX_MARKDOWN_IMPORT_BYTES) throw new Error(`“${note.title || 'Untitled note'}” is too large for a portable Markdown file.`)
    total += data.byteLength
    if (total > MAX_NOTEBOOK_DECODED_BYTES) throw new Error('The Markdown archive exceeds the 64 MiB content limit.')
    files[path] = data
  }
  const archive = zipSync(files, { level: 6 })
  if (archive.byteLength > MAX_NOTEBOOK_IMPORT_BYTES) throw new Error('The Markdown archive exceeds 32 MiB.')
  return archive
}

/** Parse and validate the complete selection before the UI offers Import.
 * No filesystem writes, Pubky calls or existing-note mutations occur here. */
export async function readNotebookImport(input: readonly File[]): Promise<NotebookImportPlan> {
  if (!input.length) throw new Error('Choose a backup, Markdown files, or a Markdown ZIP.')
  if (input.length > MAX_ARCHIVE_ENTRIES) throw new Error('Choose at most 4,000 files and folders.')
  const compressedBytes = input.reduce((sum, file) => sum + file.size, 0)
  if (compressedBytes > MAX_NOTEBOOK_IMPORT_BYTES) throw new Error('The selected files exceed the 32 MiB import limit.')
  const files = input.map(file => ({ file, path: safeArchivePath(file.webkitRelativePath || file.name) }))
  const names = new Set<string>()
  for (const { path } of files) {
    if (names.has(path)) throw new Error(`The selection contains duplicate path “${path}”.`)
    names.add(path)
  }
  if (files.length === 1 && /\.json$/i.test(files[0].path)) {
    const bytes = await readFile(files[0].file)
    return parseBackup(bytes)
  }
  if (files.some(({ path }) => /\.json$/i.test(path))) throw new Error('Import a notebook backup by itself, or choose only Markdown files and ZIP archives.')
  const markdown: Array<{ path: string; bytes: Uint8Array }> = []
  const folders: string[] = []
  let totalBytes = 0
  for (const { file, path } of files) {
    const bytes = await readFile(file)
    if (/\.zip$/i.test(path)) {
      if (files.length !== 1) throw new Error('Import one ZIP archive at a time.')
      const extracted = await extractMarkdownArchive(bytes)
      markdown.push(...extracted.files); folders.push(...extracted.folders)
      totalBytes = extracted.totalBytes
    } else {
      requireMarkdown(path)
      if (bytes.byteLength > MAX_MARKDOWN_IMPORT_BYTES) throw new Error(`“${path}” exceeds the 512 KiB Markdown file limit.`)
      totalBytes += bytes.byteLength
      if (totalBytes > MAX_NOTEBOOK_DECODED_BYTES) throw new Error('The imported contents exceed 64 MiB.')
      markdown.push({ path, bytes })
    }
  }
  if (markdown.length > MAX_NOTEBOOK_NOTES) throw new Error('Import at most 2,000 notes at a time.')
  // Directory inputs include their chosen root directory in relative paths.
  // Keeping it preserves the user's selected folder hierarchy explicitly.
  const notes = markdown.map(({ path, bytes }) => markdownNote(path, bytes))
  const normalizedFolders = completeFolders(folders, notes)
  if (!notes.length && !normalizedFolders.length) throw new Error('No Markdown notes or folders were found.')
  return { notes, folders: normalizedFolders, source: 'markdown', fileCount: markdown.length, totalBytes, historyCount: 0, deletedCount: 0 }
}

/** New IDs are assigned only once by the caller before applying its import.
 * Revalidation prevents a mutated UI plan from bypassing content/history limits. */
export function materializeNotebookImport(plan: NotebookImportPlan): { records: NoteRecord[]; folders: string[] } {
  if (!Array.isArray(plan.notes) || plan.notes.length > MAX_NOTEBOOK_NOTES) throw new Error('Import at most 2,000 notes at a time.')
  let total = 0
  const notes = plan.notes.map(value => {
    const note = cleanNote(value, true)
    total += encoder.encode(JSON.stringify(note)).byteLength
    if (total > MAX_NOTEBOOK_DECODED_BYTES) throw new Error('The imported contents exceed 64 MiB.')
    const copy = { ...note, id: crypto.randomUUID() }
    return copy.crdt ? validateCrdtNote(copy) : initializeNote(copy)
  })
  return { records: notes.map(note => ({ note, published: null })), folders: completeFolders(plan.folders, notes) }
}

function cleanNote(value: unknown, includeHistory: boolean): Note {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The backup contains an invalid note.')
  if (encoder.encode(JSON.stringify(value)).byteLength > MAX_NOTE_BYTES) throw new Error('A backup note exceeds the 4 MiB note limit.')
  const raw = value as Note
  const fields = validateFields(raw)
  if (!includeHistory || raw.crdt === undefined) return fields
  // validateCrdtNote verifies both the envelope and readable snapshot. It
  // returns only canonical note fields, never arbitrary backup properties.
  return validateCrdtNote({ ...fields, crdt: raw.crdt })
}

function completeFolders(input: readonly string[], notes: readonly Note[]): string[] {
  const paths = new Set(normalizeFolderPaths(input))
  for (const note of notes) {
    const folder = normalizeFolder(note.folder ?? '')
    if (folder) paths.add(folder)
  }
  for (const path of [...paths]) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index++) paths.add(segments.slice(0, index).join('/'))
  }
  return normalizeFolderPaths([...paths])
}

function parseBackup(bytes: Uint8Array): NotebookImportPlan {
  if (bytes.byteLength > MAX_NOTEBOOK_IMPORT_BYTES) throw new Error('The notebook backup exceeds 32 MiB.')
  let value: unknown
  try { value = JSON.parse(decoder.decode(bytes)) } catch { throw new Error('The selected file is not a valid UTF-8 notebook backup.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The selected file is not a Pubky Notes backup.')
  const raw = value as Record<string, unknown>
  if (raw.format !== FORMAT || raw.version !== 1 || !Array.isArray(raw.notes) || raw.notes.length > MAX_NOTEBOOK_NOTES) throw new Error('This notebook backup format or version is unsupported, or it exceeds 2,000 notes.')
  const notes = raw.notes.map(note => cleanNote(note, true))
  const ids = new Set<string>()
  for (const note of notes) {
    if (ids.has(note.id)) throw new Error('The backup contains duplicate note IDs.')
    ids.add(note.id)
  }
  const folders = completeFolders(normalizeFolderPaths(raw.folders), notes)
  return { notes, folders, source: 'backup', fileCount: 1, totalBytes: bytes.byteLength,
    historyCount: notes.filter(note => note.crdt).length, deletedCount: notes.filter(note => note.deleted).length }
}

function safeArchivePath(raw: string): string {
  if (!raw || raw.length > 800 || raw.startsWith('/') || /^[a-z]:/i.test(raw) || /[\\\u0000-\u001f\u007f-\u009f]/u.test(raw)) throw new Error('The selection contains an unsafe file path.')
  const path = raw.normalize('NFC')
  const directory = path.endsWith('/'), parts = path.slice(0, directory ? -1 : undefined).split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.trim() !== part)) throw new Error('The selection contains an unsafe file path.')
  if (parts.length > 9) throw new Error('Imported folders can be at most eight levels deep.')
  const parent = parts.slice(0, directory ? undefined : -1).join('/')
  if (parent) normalizeFolder(parent)
  return path
}

function requireMarkdown(path: string) {
  if (!/\.(?:md|markdown|txt)$/i.test(path)) throw new Error(`“${path}” is not a Markdown file. Choose .md, .markdown or .txt files, or a notebook backup.`)
}

function markdownNote(path: string, bytes: Uint8Array): Note {
  let text: string
  try { text = decoder.decode(bytes).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n') } catch { throw new Error(`“${path}” is not valid UTF-8 text.`) }
  const heading = text.match(/^# ([^\n]+)\n?/)
  const filename = path.split('/').at(-1)!
  const title = (heading?.[1] ?? filename.replace(/\.(?:md|markdown|txt)$/i, '')).slice(0, 200)
  const content = heading ? text.slice(heading[0].length).replace(/^\n/, '') : text
  if (content.length > MAX_CONTENT_LENGTH) throw new Error(`“${path}” exceeds the 250,000-character note limit.`)
  const now = new Date().toISOString()
  return validateFields({ id: crypto.randomUUID(), title, content, createdAt: now, updatedAt: now, folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined })
}

async function readFile(file: File): Promise<Uint8Array> {
  if (file.size > MAX_NOTEBOOK_IMPORT_BYTES) throw new Error('The selected file exceeds 32 MiB.')
  const buffer = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The selected file could not be read.'))
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('The selected file could not be read.'))
    reader.readAsArrayBuffer(file)
  })
  if (buffer.byteLength > MAX_NOTEBOOK_IMPORT_BYTES) throw new Error('The selected file exceeds 32 MiB.')
  return new Uint8Array(buffer)
}

async function extractMarkdownArchive(data: Uint8Array): Promise<{ files: Array<{ path: string; bytes: Uint8Array }>; folders: string[]; totalBytes: number }> {
  const { Unzip, UnzipInflate, unzipSync } = await import('fflate')
  const expected = new Map<string, { size: number; compression: number }>()
  let declaredBytes = 0, count = 0
  // Let the vetted parser validate the central directory before streaming any
  // output. A false filter reads metadata without allocating extracted files.
  try {
    unzipSync(data, { filter: file => {
      if (++count > MAX_ARCHIVE_ENTRIES) throw new Error('The ZIP contains more than 4,000 entries.')
      const path = safeArchivePath(file.name)
      if (expected.has(path)) throw new Error('The ZIP contains duplicate file paths.')
      if (![0, 8].includes(file.compression)) throw new Error('The ZIP uses unsupported compression.')
      const directory = path.endsWith('/')
      if (directory && file.originalSize !== 0) throw new Error('A ZIP directory contains unexpected data.')
      if (!directory) {
        requireMarkdown(path)
        if (file.originalSize > MAX_MARKDOWN_IMPORT_BYTES) throw new Error('A Markdown file in the ZIP exceeds 512 KiB.')
      }
      declaredBytes += file.originalSize
      if (declaredBytes > MAX_NOTEBOOK_DECODED_BYTES) throw new Error('The ZIP contents exceed 64 MiB.')
      expected.set(path, { size: file.originalSize, compression: file.compression })
      return false
    } })
  } catch (error) { throw archiveError(error) }
  const files: Array<{ path: string; bytes: Uint8Array }> = [], folders: string[] = [], seen = new Set<string>()
  const active: Array<{ terminate: () => void }> = []
  let totalBytes = 0, completed = 0
  const unzip = new Unzip(file => {
    const path = safeArchivePath(file.name), entry = expected.get(path)
    if (!entry || seen.has(path) || entry.compression !== file.compression || (file.originalSize !== undefined && entry.size !== file.originalSize)) throw new Error('The ZIP file records are inconsistent.')
    seen.add(path); active.push(file)
    const chunks: Uint8Array[] = []
    let length = 0
    file.ondata = (error, chunk, final) => {
      if (error) throw error
      length += chunk.byteLength; totalBytes += chunk.byteLength
      if (length > MAX_MARKDOWN_IMPORT_BYTES || totalBytes > MAX_NOTEBOOK_DECODED_BYTES || length > entry.size) throw new Error('The ZIP contents exceed the permitted size.')
      chunks.push(chunk)
      if (final) {
        if (length !== entry.size) throw new Error('A ZIP file has an invalid content size.')
        completed++
        if (path.endsWith('/')) folders.push(path.slice(0, -1))
        else {
          const bytes = new Uint8Array(length)
          let offset = 0
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
          files.push({ path, bytes })
          if (files.length > MAX_NOTEBOOK_NOTES) throw new Error('The ZIP contains more than 2,000 notes.')
        }
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    // Small compressed chunks bound transient inflation allocations even if an
    // archive lies about its uncompressed size. Limits use actual output bytes.
    for (let offset = 0; offset < data.length; offset += 1_024) unzip.push(data.subarray(offset, offset + 1_024), offset + 1_024 >= data.length)
    if (seen.size !== expected.size || completed !== expected.size) throw new Error('The ZIP is incomplete.')
  } catch (error) {
    for (const file of active) file.terminate()
    throw archiveError(error)
  }
  return { files, folders, totalBytes }
}

function archiveError(error: unknown): Error {
  return error instanceof Error ? new Error(`Could not import ZIP: ${error.message}`) : new Error('The selected ZIP could not be read.')
}
