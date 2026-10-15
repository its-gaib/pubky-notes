import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const BASE = 'http://127.0.0.1:4174'
const pane = (page: Page) => page.locator('.navigation-pane')

async function width(page: Page) {
  return (await pane(page).boundingBox())!.width
}

async function hasWidth(page: Page, expected: number) {
  await expect.poll(async () => Math.abs(await width(page) - expected)).toBeLessThan(1)
}

async function dragBorder(page: Page, delta: number) {
  const separator = page.getByRole('separator', { name: 'Resize sidebar', exact: true })
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
  expect(await width(page)).toBeGreaterThanOrEqual(159.5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('one sidebar supports real dragging, broad limits, keyboard steps, collapse, and persistent responsive widths', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(15_000)
  const page = await context.newPage(), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'New note', exact: true }).first().click()
    await page.getByRole('textbox', { name: 'Note title' }).fill('Sidebar sizing fixture')
    await page.getByRole('textbox', { name: 'Markdown content' }).fill('Local note stays intact while the sidebar border moves.')
    await hasWidth(page, 260)
    const separator = page.getByRole('separator', { name: 'Resize sidebar', exact: true })
    await expect(page.getByRole('separator')).toHaveCount(1)
    await expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    await expect(page.getByRole('button', { name: 'Open note Sidebar sizing fixture', exact: true })).toHaveCount(1)
    const navigationBox = (await pane(page).boundingBox())!
    const arrowBox = (await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).boundingBox())!
    expect(arrowBox.width).toBe(26)
    expect(navigationBox.x + navigationBox.width - (arrowBox.x + arrowBox.width)).toBeCloseTo(1)

    await dragBorder(page, 1_000)
    await hasWidth(page, 900)
    await fittedEditor(page)
    await dragBorder(page, -1_000)
    await hasWidth(page, 160)
    await dragBorder(page, 480)
    await hasWidth(page, 640)
    await separator.press('ArrowRight')
    await hasWidth(page, 650)
    await separator.press('ArrowLeft')
    await hasWidth(page, 640)
    await expect(separator).toHaveAttribute('aria-valuenow', '640')

    await page.reload()
    await hasWidth(page, 640)
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue('Local note stays intact while the sidebar border moves.')
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await expect(page.getByRole('separator')).toHaveCount(0)
    await hasWidth(page, 28)
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toHaveCount(1)
    await page.reload()
    await hasWidth(page, 28)
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await hasWidth(page, 640)

    await page.setViewportSize({ width: 701, height: 1000 })
    await hasWidth(page, 381)
    await fittedEditor(page)
    await page.screenshot({ path: '/tmp/pubky-notes-sidebar-resize-narrow.png' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await hasWidth(page, 640)
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
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible()
    await expect(page.getByRole('separator')).toHaveCount(0)
    await page.getByRole('button', { name: 'New note', exact: true }).click()
    await page.getByRole('textbox', { name: 'Note title' }).fill('Mobile resize fixture')
    await page.getByRole('textbox', { name: 'Markdown content' }).fill('Mobile editor remains available.')
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await expect(page.getByRole('separator')).toHaveCount(0)
    await page.getByRole('button', { name: 'Open note Mobile resize fixture', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toBeVisible()
    await page.setViewportSize({ width: 700, height: 844 })
    await expect(page.getByRole('separator')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.setViewportSize({ width: 701, height: 844 })
    await expect(page.getByRole('separator')).toHaveCount(1)
    await fittedEditor(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(page.getByRole('separator')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue('Mobile editor remains available.')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  } finally { await context.close() }
})
