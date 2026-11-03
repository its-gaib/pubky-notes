// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeNote } from '../lib/crdt'
import NotebookBackup from './NotebookBackup'
import { createNotebookBackup, materializeNotebookImport } from '../lib/notebook-backup'
import type { NotebookImportPlan } from '../lib/notebook-backup'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const now = '2026-11-03T00:00:00.000Z'
function record(id = 'fixture', content = 'Original private text.') {
  return { note: initializeNote({ id, title: `Note ${id}`, content, createdAt: now, updatedAt: now }), published: null }
}

describe('notebook backup panel', () => {
  it('previews all selected Markdown files and requires an explicit import action', async () => {
    const onImport = vi.fn(async (_plan: NotebookImportPlan) => {})
    render(<NotebookBackup records={[]} folders={[]} onImport={onImport} />)
    const selected = [new File(['# One\n\nFirst body.'], 'one.md'), new File(['Second body.'], 'two.md')]
    fireEvent.change(screen.getByLabelText('Import notebook files'), { target: { files: selected } })
    const preview = await screen.findByRole('region', { name: 'Import preview' })
    expect(preview.textContent).toContain('2 notes')
    expect(preview.textContent).toContain('One')
    expect(preview.textContent).toContain('two')
    expect(onImport).not.toHaveBeenCalled()
    fireEvent.click(within(preview).getByRole('button', { name: 'Import private copies' }))
    await waitFor(() => expect(onImport).toHaveBeenCalledOnce())
    const plan = onImport.mock.calls[0][0]
    expect(plan.notes.map(note => note.content)).toEqual(['First body.', 'Second body.'])
    expect(materializeNotebookImport(plan).records.every(row => row.published === null)).toBe(true)
    expect((await screen.findByRole('status')).textContent).toContain('Imported 2 notes')
  })

  it('uses a flushed export snapshot and explicit history and Trash choices', async () => {
    const initial = record(), fresh = record('fresh', 'Flushed latest private text.')
    const onPrepareExport = vi.fn(async () => ({ records: [fresh], folders: ['Fresh'] }))
    const createObjectURL = vi.fn((_blob: Blob | MediaSource) => 'blob:backup-test'), revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<NotebookBackup records={[initial]} folders={[]} onPrepareExport={onPrepareExport} onImport={async () => {}} />)
    expect((screen.getByRole('checkbox', { name: 'Include version history' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Include Trash (0)' }) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Download notebook backup' }))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce())
    expect(onPrepareExport).toHaveBeenCalledOnce()
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const text = await new Promise<string>(resolve => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob)
    })
    expect(text).toContain('Flushed latest private text.')
    expect(text).not.toContain('Original private text.')
    expect(JSON.parse(text).folders).toEqual(['Fresh'])
  })

  it('keeps a valid preview after an apply failure for retry, and never imports invalid files', async () => {
    const onImport = vi.fn(async () => { throw new Error('Device storage is full. Imported 1 of 2 notes; retry remaining notes.') })
    render(<NotebookBackup records={[]} folders={[]} onImport={onImport} />)
    const backup = createNotebookBackup({ records: [record()], folders: [] })
    fireEvent.change(screen.getByLabelText('Import notebook files'), { target: { files: [new File([backup], 'backup.json')] } })
    const preview = await screen.findByRole('region', { name: 'Import preview' })
    fireEvent.click(within(preview).getByRole('button', { name: 'Import private copies' }))
    expect((await screen.findByRole('alert')).textContent).toContain('retry remaining')
    expect(screen.getByRole('region', { name: 'Import preview' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Import notebook files'), { target: { files: [new File(['invalid'], 'bad.json')] } })
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Import preview' })).toBeNull())
    expect((await screen.findByRole('alert')).textContent).toContain('valid UTF-8 notebook backup')
    expect(onImport).toHaveBeenCalledOnce()
  })
})
