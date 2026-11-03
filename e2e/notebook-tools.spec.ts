import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'

async function createNote(page: Page, title: string, content: string) {
  await page.getByRole('button', { name: 'New note', exact: true }).first().click()
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill(title)
  await page.getByRole('textbox', { name: 'Markdown content', exact: true }).fill(content)
  await page.keyboard.press('Control+s')
  await expect(page.getByTitle('Save changes')).toContainText('Saved on this device')
}
async function createFolder(page: Page, name: string, parent?: string) {
  await page.getByRole('button', { name: parent ? `New subfolder in ${parent}` : 'New folder', exact: true }).click()
  await page.getByRole('textbox', { name: 'Folder name', exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create folder', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Folder name', exact: true })).toHaveCount(0)
}
async function backupPanel(page: Page) {
  await page.getByRole('button', { name: 'Notebook options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Backup and import', exact: true }).click()
  return page.getByRole('dialog', { name: 'Backup and import', exact: true })
}
async function localNotebook(page: Page) {
  // Inspect the durable guest records directly, independently of app helpers.
  // This also works against the production bundle without source-module URLs.
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pubky-notes:local:v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const transaction = db.transaction(['notes', 'metadata'], 'readonly')
      const read = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      const [notes, metadata] = await Promise.all([read(transaction.objectStore('notes').getAll()), read(transaction.objectStore('metadata').getAll())])
      const scopes = new Set([...notes, ...metadata].map(row => row.scope).filter(scope => scope.endsWith(':guest')))
      if (scopes.size !== 1) throw new Error('Expected one disposable guest notebook')
      const scope = [...scopes][0]
      return { records: notes.filter(row => row.scope === scope).map(row => row.record), folders: metadata.find(row => row.scope === scope)?.folders ?? [] }
    } finally { db.close() }
  })
}

test('full-text search finds deep body text across folders and pinned views, with excerpts and a keyboard switcher', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await createFolder(page, 'Work')
  await createFolder(page, 'Research', 'Work')
  await createNote(page, 'Research log', `${'Earlier material. '.repeat(150)}\nThe violet comet carries [a+b].* and <tag> 日本語.`)
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await createNote(page, 'Violet plans', 'A comet appears in this report.')
  await page.getByRole('button', { name: 'Pin note Violet plans', exact: true }).click()
  await createNote(page, 'Unrelated', 'Ordinary words in another note.')
  await page.getByRole('button', { name: 'Collapse folder Work', exact: true }).click()
  await page.getByRole('button', { name: 'Pinned notes', exact: true }).click()
  const tree = page.getByRole('navigation', { name: 'Folders and notes', exact: true })
  await expect(tree.getByRole('button', { name: 'Open note Violet plans', exact: true })).toBeVisible()
  await expect(tree.getByRole('button', { name: 'Open note Research log', exact: true })).toHaveCount(0)
  const search = page.getByRole('searchbox', { name: 'Search all notes', exact: true })
  await search.fill('VIOLET comet')
  const bodyMatch = tree.getByRole('button', { name: 'Open note Research log', exact: true })
  await expect(bodyMatch).toBeVisible()
  await expect(bodyMatch.locator('.note-search-excerpt')).toContainText('violet comet')
  await expect(bodyMatch.locator('.note-search-excerpt mark')).toHaveText(['violet', 'comet'])
  await expect(tree.getByRole('button', { name: 'Open note Violet plans', exact: true })).toBeVisible()
  await expect(tree.getByRole('button', { name: 'Open note Unrelated', exact: true })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('full-text-search-desktop.png'), fullPage: true })
  await search.fill('[a+b].*')
  await expect(bodyMatch).toBeVisible()
  await expect(bodyMatch.locator('mark')).toHaveText('[a+b].*')
  await expect(tree.getByRole('button', { name: 'Open note Violet plans', exact: true })).toHaveCount(0)
  await search.fill('<tag> 日本語')
  await expect(bodyMatch).toBeVisible()
  await expect(bodyMatch.locator('.note-search-excerpt')).toContainText('<tag> 日本語')
  await expect(bodyMatch.locator('tag, img, script')).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear search', exact: true }).first().click()
  await expect(tree.getByRole('button', { name: 'Open note Research log', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Pinned notes', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Control+p')
  const switcher = page.getByRole('dialog', { name: 'Find a note', exact: true })
  const field = switcher.getByRole('combobox', { name: 'Find a note', exact: true })
  await expect(field).toBeFocused()
  await field.fill('[a+b].*')
  await expect(switcher.getByRole('option')).toHaveCount(1)
  await field.press('Enter')
  await expect(switcher).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue('Research log')
  await page.getByRole('button', { name: 'Recent notes', exact: true }).click()
  await expect(tree.locator('[data-tree-note-id]').first()).toContainText('Research log')
  await page.reload()
  await page.getByRole('button', { name: 'Pinned notes', exact: true }).click()
  await expect(tree.getByRole('button', { name: 'Open note Violet plans', exact: true })).toBeVisible()
  await expect(tree.getByRole('button', { name: 'Open note Research log', exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await search.fill('comet')
  await expect(bodyMatch).toBeVisible()
  await expect.poll(() => bodyMatch.locator('.note-search-excerpt mark').first().evaluate(mark => {
    const match = mark.getBoundingClientRect(), excerpt = mark.closest('.note-search-excerpt')!.getBoundingClientRect()
    return match.top >= excerpt.top - 1 && match.bottom <= excerpt.bottom + 1
  })).toBe(true)
  await page.screenshot({ path: test.info().outputPath('full-text-search-mobile.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('whole-notebook backup restores private copies with folders and history, and Markdown ZIP imports in a fresh notebook', async ({ page, browser }) => {
  await page.goto('/')
  await createFolder(page, 'Work')
  await createFolder(page, 'Empty', 'Work')
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await createNote(page, 'Alpha', 'Old private text for history.')
  await page.getByRole('textbox', { name: 'Markdown content', exact: true }).fill('Latest Alpha body.')
  await page.keyboard.press('Control+s')
  await expect(page.getByTitle('Save changes')).toContainText('Saved on this device')
  await page.getByRole('button', { name: 'Open folder Work', exact: true }).click()
  await createNote(page, 'Beta', 'Beta body with **formatting**.')
  let panel = await backupPanel(page)
  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Download notebook backup', exact: true }).click()
  const download = await downloadPromise
  const data = await readFile((await download.path())!, 'utf8')
  const backup = JSON.parse(data)
  expect(backup.notes).toHaveLength(2)
  expect(backup.notes.every((note: { crdt?: unknown }) => !!note.crdt)).toBe(true)
  expect(backup.folders).toContain('Work/Empty')
  expect(backup.notes.find((note: { title: string }) => note.title === 'Alpha').content).toBe('Latest Alpha body.')
  expect(backup.notes.some((note: { published?: unknown }) => note.published)).toBe(false)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await createNote(page, 'Keep me', 'Must survive restoration.')
  const before = await localNotebook(page)
  panel = await backupPanel(page)
  await panel.getByLabel('Import notebook files', { exact: true }).setInputFiles({ name: 'notebook.pubky-notes.json', mimeType: 'application/json', buffer: Buffer.from(data) })
  await expect(panel.getByRole('region', { name: 'Import preview', exact: true })).toContainText('2 notes')
  expect((await localNotebook(page)).records).toHaveLength(3)
  await panel.getByRole('button', { name: 'Import private copies', exact: true }).click()
  await expect(panel).toHaveCount(0)
  const restored = await localNotebook(page)
  expect(restored.records).toHaveLength(5)
  for (const original of before.records) {
    expect(restored.records.find((row: { note: { id: string } }) => row.note.id === original.note.id)?.note.content).toBe(original.note.content)
  }
  const oldIds = new Set(before.records.map((row: { note: { id: string } }) => row.note.id))
  const copies = restored.records.filter((row: { note: { id: string } }) => !oldIds.has(row.note.id))
  expect(copies).toHaveLength(2)
  expect(copies.every((row: { published: unknown; note: { crdt?: unknown } }) => row.published === null && !!row.note.crdt)).toBe(true)
  expect(restored.folders).toContain('Work/Empty')
  await page.reload()
  expect((await localNotebook(page)).records).toHaveLength(5)
  panel = await backupPanel(page)
  const archivePromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export Markdown ZIP', exact: true }).click()
  const archiveDownload = await archivePromise
  const archive = await readFile((await archiveDownload.path())!)
  const files = unzipSync(archive)
  const markdown = Object.entries(files).filter(([name]) => name.endsWith('.md'))
  expect(markdown).toHaveLength(5)
  expect(markdown.some(([, bytes]) => strFromU8(bytes).includes('Must survive restoration.'))).toBe(true)
  await page.screenshot({ path: test.info().outputPath('backup-and-import.png'), fullPage: true })
  const other = await browser.newPage()
  try {
    await other.goto('http://127.0.0.1:4174/')
    const otherPanel = await backupPanel(other)
    await otherPanel.getByLabel('Import notebook files', { exact: true }).setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: archive })
    await expect(otherPanel.getByRole('region', { name: 'Import preview', exact: true })).toContainText('5 notes')
    await otherPanel.getByRole('button', { name: 'Import private copies', exact: true }).click()
    await expect(otherPanel).toHaveCount(0)
    const portable = await localNotebook(other)
    expect(portable.records).toHaveLength(5)
    expect(portable.records.every((row: { published: unknown }) => row.published === null)).toBe(true)
    expect(portable.folders).toContain('Work/Empty')
  } finally { await other.close() }
})
