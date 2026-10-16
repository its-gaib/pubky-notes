import { expect, test as base } from '@playwright/test'
import type { Page } from '@playwright/test'

const BASE = 'http://127.0.0.1:4174'
type Account = { page: Page }
type StoredNote = { note: { id: string; title: string; content: string; folder?: string }; published: unknown }

const test = base.extend<{ account: Account }>({
  account: [async ({ browser }, use) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(15_000)
    await context.addInitScript(() => {
      const drops: { trusted: boolean; types: string[] }[] = []
      Object.assign(window, { __folderTestDrops: drops })
      document.addEventListener('drop', event => {
        drops.push({ trusted: event.isTrusted, types: Array.from(event.dataTransfer?.types ?? []) })
      }, true)
    })
    const page = await context.newPage()
    try {
      await page.goto(`${BASE}/e2e/fixture.html`)
      await page.evaluate(async () => {
        const path = '/e2e/browser-account.ts'
        await (await import(/* @vite-ignore */ path)).createAccount()
      })
      await page.goto(BASE)
      await expect(page.getByRole('button', { name: 'Disconnect from Pubky' })).toBeVisible()
      await use({ page })
    } finally {
      try {
        await page.goto(`${BASE}/e2e/fixture.html`)
        await page.evaluate(async () => {
          const path = '/e2e/browser-account.ts'
          await (await import(/* @vite-ignore */ path)).cleanAccount()
        })
      } finally { await context.close() }
    }
  }, { timeout: 60_000 }],
})

async function createFolder(page: Page, name: string, parent = '') {
  if (parent) {
    await page.getByRole('button', { name: `Folder actions for ${parent}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'New subfolder', exact: true }).click()
  } else await page.getByRole('button', { name: 'New folder', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Folder name', exact: true })
  await expect(input).toBeVisible()
  expect(await input.evaluate(element => !!element.closest('#notebook-navigation'))).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await input.fill(name)
  await page.getByRole('button', { name: 'Create folder', exact: true }).click()
  await expect(input).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Open folder ${parent ? `${parent}/` : ''}${name}`, exact: true })).toBeVisible()
}

async function readNotes(page: Page): Promise<StoredNote[]> {
  return page.evaluate(async () => {
    const path = '/e2e/browser-account.ts'
    return (await import(/* @vite-ignore */ path)).readNotes()
  })
}

async function savedFolder(page: Page, title: string, folder: string) {
  await expect.poll(async () => (await readNotes(page)).find(row => row.note.title === title)?.note.folder ?? '',
    { message: 'The real homeserver note must retain its moved folder' }).toBe(folder)
}

test('native sidebar dragging moves notes and folder descendants, renames inline, and persists safely', async ({ account: { page } }) => {
  const title = 'Native drag fixture', content = 'Keep the document text intact through all sidebar operations.'
  await createFolder(page, 'Projects')
  await createFolder(page, 'Drafts', 'Projects')
  await createFolder(page, 'Archive')
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByRole('button', { name: 'New note', exact: true }).first().click()
  await page.getByRole('textbox', { name: 'Note title' }).fill(title)
  await page.getByRole('textbox', { name: 'Markdown content' }).fill(content)
  const noteButton = page.getByRole('button', { name: `Open note ${title}`, exact: true })
  const folder = (path: string) => page.getByRole('button', { name: `Open folder ${path}`, exact: true })
  const rootSpace = page.getByRole('region', { name: 'Move to top level', exact: true })
  await expect(page.getByRole('button', { name: 'Unfiled', exact: true })).toHaveCount(0)
  await expect(noteButton).toBeVisible()
  await expect(rootSpace).toBeVisible()
  expect((await rootSpace.boundingBox())!.height).toBeGreaterThanOrEqual(40)

  await noteButton.dragTo(folder('Projects/Drafts'))
  await savedFolder(page, title, 'Projects/Drafts')
  expect(await noteButton.evaluate(element => element.closest('[data-folder-path]')?.getAttribute('data-folder-path'))).toBe('Projects/Drafts')
  await page.getByRole('button', { name: 'Collapse folder Projects', exact: true }).click()
  await expect(noteButton).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand folder Projects', exact: true }).click()
  await expect(noteButton).toBeVisible()
  await noteButton.dragTo(rootSpace)
  await savedFolder(page, title, '')
  await noteButton.dragTo(folder('Projects/Drafts'))
  await savedFolder(page, title, 'Projects/Drafts')

  await folder('Projects').dragTo(folder('Archive'))
  await expect(folder('Archive/Projects/Drafts')).toBeVisible()
  await expect(folder('Projects')).toHaveCount(0)
  await savedFolder(page, title, 'Archive/Projects/Drafts')
  // A forbidden descendant drop must not bubble into a root move.
  await folder('Archive/Projects').dragTo(folder('Archive/Projects/Drafts'))
  await expect(folder('Archive/Projects/Drafts')).toBeVisible()
  await expect(folder('Projects')).toHaveCount(0)
  await savedFolder(page, title, 'Archive/Projects/Drafts')
  await folder('Archive/Projects').dragTo(rootSpace)
  await expect(folder('Projects/Drafts')).toBeVisible()
  await expect(folder('Archive/Projects')).toHaveCount(0)
  await savedFolder(page, title, 'Projects/Drafts')
  const earlierDrops = await page.evaluate(() => (window as typeof window & { __folderTestDrops: { trusted: boolean; types: string[] }[] }).__folderTestDrops)
  await page.reload()
  await expect(folder('Projects/Drafts')).toBeVisible()
  await expect(folder('Archive/Projects')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(content)

  await folder('Projects').click()
  await folder('Projects').dblclick()
  const rename = page.getByRole('textbox', { name: 'Folder name', exact: true })
  await expect(rename).toHaveValue('Projects')
  expect(await rename.evaluate(element => !!element.closest('#notebook-navigation'))).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(content)
  await rename.fill('Writing')
  await page.getByRole('button', { name: 'Rename folder', exact: true }).click()
  await expect(folder('Writing/Drafts')).toBeVisible()
  await savedFolder(page, title, 'Writing/Drafts')
  expect(await noteButton.evaluate(element => element.closest('[data-folder-path]')?.getAttribute('data-folder-path'))).toBe('Writing/Drafts')
  await page.screenshot({ path: '/tmp/pubky-notes-folder-tree-desktop.png' })
  await expect(page.getByRole('button', { name: 'Delete folder Writing', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete folder Writing/Drafts', exact: true })).toBeDisabled()

  await noteButton.dragTo(rootSpace)
  await savedFolder(page, title, '')
  await expect(page.getByRole('button', { name: 'Delete folder Writing', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Delete folder Writing/Drafts', exact: true }).click()
  await expect(folder('Writing/Drafts')).toHaveCount(0)
  await page.getByRole('button', { name: 'Delete folder Writing', exact: true }).click()
  await expect(folder('Writing')).toHaveCount(0)

  const drops = [...earlierDrops, ...await page.evaluate(() => (window as typeof window & { __folderTestDrops: { trusted: boolean; types: string[] }[] }).__folderTestDrops)]
  expect(drops.length).toBeGreaterThanOrEqual(6)
  expect(drops.every(drop => drop.trusted && drop.types.includes('application/x-pubky-notes'))).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await expect(folder('Archive')).toBeVisible()
  await expect(folder('Writing')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(content)
  const actual = (await readNotes(page)).find(row => row.note.title === title)!
  expect(actual.note.folder || '').toBe('')
  expect(actual.note.content).toBe(content)
  expect(actual.published).toBeNull()
})

test('mobile sidebar move controls organize local notes and folders without editor overlays', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  context.setDefaultTimeout(15_000)
  const page = await context.newPage()
  try {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Unfiled', exact: true })).toHaveCount(0)
    await createFolder(page, 'Travel')
    await page.getByRole('button', { name: 'New note', exact: true }).click()
    await page.getByRole('textbox', { name: 'Note title' }).fill('Mobile move fixture')
    await page.getByRole('textbox', { name: 'Markdown content' }).fill('Mobile note remains intact.')
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await createFolder(page, 'Archive')
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    await page.getByRole('button', { name: 'Note actions for Mobile move fixture', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click()
    const moveNote = page.getByRole('combobox', { name: 'Move note to', exact: true })
    expect(await moveNote.evaluate(element => !!element.closest('#notebook-navigation'))).toBe(true)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await moveNote.selectOption('Archive')
    await page.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(moveNote).toHaveCount(0)
    expect(await page.getByRole('button', { name: 'Open note Mobile move fixture', exact: true }).evaluate(element => element.closest('[data-folder-path]')?.getAttribute('data-folder-path'))).toBe('Archive')

    await page.getByRole('button', { name: 'Folder actions for Travel', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click()
    const moveFolder = page.getByRole('combobox', { name: 'Move folder to', exact: true })
    expect(await moveFolder.evaluate(element => !!element.closest('#notebook-navigation'))).toBe(true)
    await moveFolder.selectOption('Archive')
    await page.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open folder Archive/Travel', exact: true })).toBeVisible()
    const treeNote = page.getByRole('button', { name: 'Open note Mobile move fixture', exact: true })
    await expect(treeNote).toBeVisible()
    expect(await treeNote.evaluate(element => element.closest('[data-folder-path]')?.getAttribute('data-folder-path'))).toBe('Archive')
    await page.screenshot({ path: '/tmp/pubky-notes-folder-tree-mobile.png' })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await treeNote.click()
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue('Mobile note remains intact.')
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open folder Archive/Travel', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    expect(await page.getByRole('button', { name: 'Open note Mobile move fixture', exact: true }).evaluate(element => element.closest('[data-folder-path]')?.getAttribute('data-folder-path'))).toBe('Archive')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await context.close() }
})

test('the unified tree searches note contents across collapsed folders and keeps Trash in the notebook menu', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(15_000)
  const page = await context.newPage(), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(BASE)
    for (const label of ['All notes', 'Private', 'Public', 'Trash']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0)
    }
    await createFolder(page, 'Projects')
    await createFolder(page, 'Drafts', 'Projects')
    await page.getByRole('button', { name: 'New note', exact: true }).first().click()
    await page.getByRole('textbox', { name: 'Note title' }).fill('Hidden draft')
    await page.getByRole('textbox', { name: 'Markdown content' }).fill('A unique searchneedle in the note body.')
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    await page.getByRole('button', { name: 'New note', exact: true }).click()
    await page.getByRole('textbox', { name: 'Note title' }).fill('Root note')
    await page.getByRole('textbox', { name: 'Markdown content' }).fill('Other text.')
    await page.getByRole('button', { name: 'Collapse folder Projects', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open note Hidden draft', exact: true })).toHaveCount(0)
    const search = page.getByRole('searchbox', { name: 'Search all notes', exact: true })
    await search.fill('SEARCHNEEDLE')
    await expect(page.getByRole('button', { name: 'Open folder Projects/Drafts', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open note Hidden draft', exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Open note Root note', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Open note Hidden draft', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue('A unique searchneedle in the note body.')
    await expect(page.getByLabel('Private note', { exact: true })).toBeVisible()
    await search.fill('root NOTE')
    await expect(page.getByRole('button', { name: 'Open note Root note', exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Open note Hidden draft', exact: true })).toHaveCount(0)
    await search.fill('searchneedle')
    await page.getByRole('button', { name: 'Note actions for Hidden draft', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Move to Trash', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Notebook options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Trash', exact: true }).click()
    await expect(page.getByRole('searchbox', { name: 'Search Trash', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open note Hidden draft', exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Open note Root note', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Note actions for Hidden draft', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Restore', exact: true }).click()
    await expect(search).toBeVisible()
    await page.getByRole('button', { name: 'Notebook options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Trash', exact: true }).click()
    await expect(page.getByText('Trash is empty.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back to notes', exact: true }).click()
    await search.fill('searchneedle')
    await expect(page.getByRole('button', { name: 'Open note Hidden draft', exact: true })).toBeVisible()
    await page.screenshot({ path: '/tmp/pubky-notes-unified-search-desktop.png' })
    expect(errors).toEqual([])
  } finally { await context.close() }
})
