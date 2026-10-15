import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const BASE = 'http://127.0.0.1:4174'
const pane = (page: Page, name: 'navigation' | 'notes') => page.locator(`.${name}-pane`)

async function width(page: Page, name: 'navigation' | 'notes') {
  return (await pane(page, name).boundingBox())!.width
}

async function hasWidth(page: Page, name: 'navigation' | 'notes', expected: number) {
  await expect.poll(async () => Math.abs(await width(page, name) - expected)).toBeLessThan(1)
}

async function dragBorder(page: Page, name: 'navigation' | 'notes', delta: number) {
  const separator = page.getByRole('separator', { name: `Resize ${name}`, exact: true })
  await expect(separator).toBeVisible()
  const box = (await separator.boundingBox())!
  const x = box.x + box.width / 2, y = box.y + box.height / 4
  // Stay away from the middle collapse arrow and use native pointer capture.
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(Math.max(5, Math.min(page.viewportSize()!.width - 5, x + delta)), y, { steps: 12 })
  await page.mouse.up()
}

async function fittedEditor(page: Page) {
  await expect.poll(async () => (await page.locator('.editor-panel').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(319.5)
  expect(await width(page, 'navigation')).toBeGreaterThanOrEqual(159.5)
  expect(await width(page, 'notes')).toBeGreaterThanOrEqual(199.5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('sidebar borders support real dragging, limits, keyboard steps, collapse, and persistent responsive widths', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(15_000)
  const page = await context.newPage(), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'New note', exact: true }).first().click()
    await page.getByRole('textbox', { name: 'Note title' }).fill('Sidebar sizing fixture')
    await page.getByRole('textbox', { name: 'Markdown content' }).fill('Local note stays intact while both sidebar borders move.')
    await hasWidth(page, 'navigation', 174)
    await hasWidth(page, 'notes', 242)
    await expect(page.getByRole('separator', { name: 'Resize navigation', exact: true })).toHaveAttribute('aria-orientation', 'vertical')
    await expect(page.getByRole('separator', { name: 'Resize notes', exact: true })).toHaveAttribute('aria-orientation', 'vertical')

    await dragBorder(page, 'navigation', 1_000)
    await hasWidth(page, 'navigation', 360)
    await dragBorder(page, 'notes', 1_000)
    await hasWidth(page, 'notes', 480)
    await dragBorder(page, 'navigation', -1_000)
    await hasWidth(page, 'navigation', 160)
    await dragBorder(page, 'notes', -1_000)
    await hasWidth(page, 'notes', 200)
    await dragBorder(page, 'navigation', 100)
    await dragBorder(page, 'notes', 130)
    await hasWidth(page, 'navigation', 260)
    await hasWidth(page, 'notes', 330)
    await page.getByRole('separator', { name: 'Resize navigation', exact: true }).press('ArrowRight')
    await page.getByRole('separator', { name: 'Resize notes', exact: true }).press('ArrowLeft')
    await hasWidth(page, 'navigation', 270)
    await hasWidth(page, 'notes', 320)
    await expect(page.getByRole('separator', { name: 'Resize navigation', exact: true })).toHaveAttribute('aria-valuenow', '270')
    await expect(page.getByRole('separator', { name: 'Resize notes', exact: true })).toHaveAttribute('aria-valuenow', '320')

    await page.reload()
    await hasWidth(page, 'navigation', 270)
    await hasWidth(page, 'notes', 320)
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue('Local note stays intact while both sidebar borders move.')
    await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click()
    await expect(page.getByRole('separator', { name: 'Resize navigation', exact: true })).toHaveCount(0)
    await hasWidth(page, 'notes', 320)
    await page.getByRole('button', { name: 'Expand navigation', exact: true }).click()
    await hasWidth(page, 'navigation', 270)
    await page.getByRole('button', { name: 'Collapse notes', exact: true }).click()
    await expect(page.getByRole('separator', { name: 'Resize notes', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Expand notes', exact: true }).click()
    await hasWidth(page, 'notes', 320)
    await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click()
    await page.getByRole('button', { name: 'Collapse notes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Expand sidebars', exact: true })).toHaveCount(1)
    await expect(page.getByRole('separator')).toHaveCount(0)
    await page.getByRole('button', { name: 'Expand sidebars', exact: true }).click()
    await hasWidth(page, 'navigation', 270)
    await hasWidth(page, 'notes', 320)

    await page.setViewportSize({ width: 701, height: 1000 })
    await fittedEditor(page)
    await page.screenshot({ path: '/tmp/pubky-notes-sidebar-resize-narrow.png' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await hasWidth(page, 'navigation', 270)
    await hasWidth(page, 'notes', 320)
    await page.screenshot({ path: '/tmp/pubky-notes-sidebar-resize-desktop.png' })
    expect(errors).toEqual([])
  } finally { await context.close() }
})

test('mobile sidebar navigation stays usable without resize handles at or below the breakpoint', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  context.setDefaultTimeout(15_000)
  const page = await context.newPage(), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(BASE)
    await expect(page.getByRole('separator')).toHaveCount(0)
    await page.getByRole('button', { name: 'Expand navigation', exact: true }).click()
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible()
    await expect(page.getByRole('separator')).toHaveCount(0)
    await page.getByRole('button', { name: 'New note', exact: true }).click()
    await page.getByRole('textbox', { name: 'Note title' }).fill('Mobile resize fixture')
    await page.getByRole('textbox', { name: 'Markdown content' }).fill('Mobile editor remains available.')
    await expect(page.getByRole('button', { name: 'Expand sidebars', exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: 'Expand sidebars', exact: true }).click()
    await expect(page.getByRole('separator')).toHaveCount(0)
    await page.getByRole('button', { name: 'Open note Mobile resize fixture in folder tree', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toBeVisible()
    await page.setViewportSize({ width: 700, height: 844 })
    await expect(page.getByRole('separator')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.setViewportSize({ width: 701, height: 844 })
    await expect(page.getByRole('separator')).toHaveCount(2)
    await fittedEditor(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(page.getByRole('separator')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue('Mobile editor remains available.')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  } finally { await context.close() }
})
