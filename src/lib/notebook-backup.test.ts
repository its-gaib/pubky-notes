import { describe, expect, it, vi } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { checkpointNote, editNote, initializeNote, listNoteVersions, readNoteVersion } from './crdt'
import type { NoteRecord } from './notes'
import { createMarkdownArchive, createNotebookBackup, materializeNotebookImport, MAX_NOTEBOOK_IMPORT_BYTES, readNotebookImport } from './notebook-backup'

const now = '2026-11-03T00:00:00.000Z'
function record(id = 'fixture', content = 'First saved text.', folder = 'Work/Ideas'): NoteRecord {
  return { note: initializeNote({ id, title: `Note ${id}`, content, folder, createdAt: now, updatedAt: now }), published: null }
}
function file(content: string | Uint8Array<ArrayBuffer>, name = 'notebook.pubky-notes.json') { return new File([content], name) }
function document(notes = [record().note]) {
  return JSON.stringify({ format: 'pubky-notes-backup', version: 1, exportedAt: now, notes, folders: ['Empty', 'Work/Ideas'] })
}

describe('whole notebook backup and import', () => {
  it('exports an explicit private allowlist, and makes history and Trash selectable', () => {
    const live = record(), trash = record('trash')
    trash.note = editNote(trash.note, { deleted: true })
    live.published = { ...live.note, content: 'PUBLIC SNAPSHOT SHOULD NOT BE IN BACKUP' }
    const snapshot = { records: [live, trash], folders: ['Empty'] }
    const json = createNotebookBackup(snapshot, { includeHistory: false, includeTrash: false })
    const backup = JSON.parse(json)
    expect(Object.keys(backup).sort()).toEqual(['exportedAt', 'folders', 'format', 'notes', 'version'])
    expect(backup.notes).toHaveLength(1)
    expect(backup.notes[0].crdt).toBeUndefined()
    expect(json).not.toContain('PUBLIC SNAPSHOT')
    expect(backup.folders).toEqual(['Empty', 'Work', 'Work/Ideas'])
    const withHistory = JSON.parse(createNotebookBackup(snapshot, { includeHistory: true, includeTrash: true }))
    expect(withHistory.notes).toHaveLength(2)
    expect(withHistory.notes[0].crdt.version).toBe(1)
    expect(withHistory.notes[1].deleted).toBe(true)
  })

  it('preserves validated history in new independent private copies without overwriting IDs', async () => {
    const row = record()
    row.note = checkpointNote(editNote(row.note, { content: 'Later saved text.' }))
    const versions = listNoteVersions(row.note)
    const json = createNotebookBackup({ records: [row], folders: ['Empty'] })
    const plan = await readNotebookImport([file(json)])
    expect(plan).toMatchObject({ source: 'backup', historyCount: 1, deletedCount: 0, fileCount: 1 })
    const first = materializeNotebookImport(plan), second = materializeNotebookImport(plan)
    expect(first.records[0].note.id).not.toBe(row.note.id)
    expect(second.records[0].note.id).not.toBe(first.records[0].note.id)
    expect(first.records[0].published).toBeNull()
    expect(first.records[0].note.content).toBe('Later saved text.')
    expect(listNoteVersions(first.records[0].note)).toEqual(versions)
    expect(readNoteVersion(first.records[0].note, versions[0].id).content).toBe('First saved text.')
    expect(first.folders).toEqual(['Empty', 'Work', 'Work/Ideas'])
  })

  it('revalidates a modified preview plan before applying any import', async () => {
    const plan = await readNotebookImport([file(document())])
    plan.notes[0].content = 'Forged snapshot that does not match history'
    expect(() => materializeNotebookImport(plan)).toThrow('snapshot does not match')
  })

  it('imports multiple Markdown files and preserves relative folder names without rendering HTML', async () => {
    const first = file('# Meeting\r\n\r\nNotes with <script>alert(1)</script>.', 'meeting.md')
    Object.defineProperty(first, 'webkitRelativePath', { value: 'Notebook/Work/meeting.md' })
    const second = file('A plain note.', 'plain.txt')
    Object.defineProperty(second, 'webkitRelativePath', { value: 'Notebook/plain.txt' })
    const plan = await readNotebookImport([first, second])
    expect(plan.notes.map(note => [note.title, note.content, note.folder])).toEqual([
      ['Meeting', 'Notes with <script>alert(1)</script>.', 'Notebook/Work'],
      ['plain', 'A plain note.', 'Notebook'],
    ])
    expect(plan.folders).toEqual(['Notebook', 'Notebook/Work'])
    expect(plan.historyCount).toBe(0)
  })

  it('round trips a portable ZIP with duplicate titles and empty folders', async () => {
    const a = record('first'), b = record('second')
    a.note = editNote(a.note, { title: 'Same title' }); b.note = editNote(b.note, { title: 'Same title' })
    const archive = await createMarkdownArchive({ records: [a, b], folders: ['Empty'] })
    const entries = Object.keys(unzipSync(archive))
    expect(entries).toContain('Empty/')
    expect(entries.filter(path => path.endsWith('.md'))).toHaveLength(2)
    const plan = await readNotebookImport([file(archive, 'notes.zip')])
    expect(plan.notes.map(note => [note.title, note.content, note.folder])).toEqual([
      ['Same title', 'First saved text.', 'Work/Ideas'], ['Same title', 'First saved text.', 'Work/Ideas'],
    ])
    expect(plan.folders).toContain('Empty')
  })

  it('rejects unsupported backups, repeated IDs, forged histories, and unsafe folders before applying', async () => {
    await expect(readNotebookImport([file('{"format":"pubky-notes-backup","version":900,"notes":[],"folders":[]}')])).rejects.toThrow('unsupported')
    await expect(readNotebookImport([file(document([record().note, record().note]))])).rejects.toThrow('duplicate note IDs')
    const note = record().note
    await expect(readNotebookImport([file(document([{ ...note, content: 'Mismatch' }]))])).rejects.toThrow('snapshot does not match')
    await expect(readNotebookImport([file(document([{ ...note, folder: '../escape' }]))])).rejects.toThrow('Folder names')
  })

  it('checks input size before reading and limits Markdown characters and archive paths', async () => {
    const arrayBuffer = vi.fn()
    const huge = { name: 'huge.json', size: MAX_NOTEBOOK_IMPORT_BYTES + 1, arrayBuffer } as unknown as File
    await expect(readNotebookImport([huge])).rejects.toThrow('32 MiB')
    expect(arrayBuffer).not.toHaveBeenCalled()
    await expect(readNotebookImport([file('x'.repeat(250_001), 'huge.md')])).rejects.toThrow('250,000')
    for (const path of ['../escape.md', '/absolute.md', 'C:/drive.md', 'folder\\escape.md', 'folder/../escape.md']) {
      const archive = zipSync({ [path]: strToU8('Not a path to write.') })
      await expect(readNotebookImport([file(archive, 'unsafe.zip')])).rejects.toThrow('unsafe file path')
    }
  })

  it('rejects oversized ZIP expansion, nested archives and truncated archives', async () => {
    const tooLarge = zipSync({ 'bomb.md': strToU8('x'.repeat(512 * 1024 + 1)) })
    await expect(readNotebookImport([file(tooLarge, 'large.zip')])).rejects.toThrow('512 KiB')
    const nested = zipSync({ 'nested.zip': new Uint8Array([1, 2, 3]) })
    await expect(readNotebookImport([file(nested, 'nested.zip')])).rejects.toThrow('not a Markdown file')
    const archive = zipSync({ 'note.md': strToU8('Hello') })
    await expect(readNotebookImport([file(archive.slice(0, 30), 'truncated.zip')])).rejects.toThrow('ZIP')
  })
})
