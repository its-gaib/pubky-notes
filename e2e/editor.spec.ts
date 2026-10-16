import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'

// Test-only: opaque Mermaid frames fetch pinned assets from our loopback Vite
// server. Production serves these assets from a public HTTPS origin.
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } })

test('table picker preserves the insertion point and supports custom dimensions on mobile', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New note', exact: true }).first().click()
  const editor = page.getByRole('textbox', { name: 'Markdown content' })
  await editor.fill('Before chosen After')
  await editor.evaluate(node => { (node as HTMLTextAreaElement).setSelectionRange(7, 13) })
  await page.getByRole('button', { name: 'Insert table', exact: true }).click()
  await page.getByRole('gridcell', { name: '4 columns, 3 rows', exact: true }).click()
  await expect(editor).toHaveValue(/^Before \n\n\| Header 1 \| Header 2 \| Header 3 \| Header 4 \|[\s\S]*\n\n After$/)
  await expect(editor).toBeFocused()
  await expect.poll(() => editor.evaluate(node => {
    const field = node as HTMLTextAreaElement
    return field.value.slice(field.selectionStart, field.selectionEnd)
  })).toBe('Header 1')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3)
  await expect(page.getByRole('table').getByRole('columnheader')).toHaveCount(4)
  await page.getByRole('button', { name: 'Write', exact: true }).click()
  await editor.fill('')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Insert table', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Insert table' })
  await expect(picker).toBeVisible()
  const bounds = await picker.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await picker.getByRole('spinbutton', { name: 'Columns' }).fill('12')
  await picker.getByRole('spinbutton', { name: 'Rows' }).fill('5')
  await page.screenshot({ path: test.info().outputPath('table-picker-mobile.png') })
  await picker.getByRole('button', { name: 'Insert table', exact: true }).click()
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(5)
  await expect(page.getByRole('table').getByRole('columnheader')).toHaveCount(12)
})

test('Mermaid preview stays mounted across unrelated updates under production CSP and preserves source on syntax errors', async ({ page }) => {
  const configuration = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  const policy = configuration.headers.flatMap((entry: { headers: { key: string; value: string }[] }) => entry.headers)
    .find((header: { key: string }) => header.key.toLowerCase() === 'content-security-policy').value
  await page.route('http://127.0.0.1:4174/', async route => {
    const response = await route.fetch()
    // Vite's development-only React preamble is inline; permit only its exact
    // hash. The Mermaid runtime/display frames retain the production policy.
    const html = await response.text()
    const hashes = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`).join(' ')
    const developmentPolicy = policy.replace('script-src ', `script-src ${hashes} `)
    await route.fulfill({ response, body: html, headers: { ...response.headers(), 'content-security-policy': developmentPolicy } })
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'New note', exact: true }).first().click()
  const editor = page.getByRole('textbox', { name: 'Markdown content' })
  const source = '```mermaid\nflowchart LR\n  Idea --> Draft --> Publish\n```'
  await editor.fill(source)
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const diagram = page.frameLocator('iframe[title="Mermaid diagram"]')
  await expect(diagram.locator('svg')).toBeVisible({ timeout: 30_000 })
  await expect(diagram.locator('svg')).toContainText('Publish')
  await expect(page.locator('iframe[title="Mermaid diagram"]')).toHaveAttribute('sandbox', '')
  await expect(page.locator('iframe[title="Rendering Mermaid diagram"]')).toHaveCount(0)
  await page.getByText('Diagram source', { exact: true }).click()
  await expect(page.locator('.mermaid-source code')).toContainText('Idea --> Draft --> Publish')
  const display = page.locator('iframe[title="Mermaid diagram"]')
  const originalFrame = await display.elementHandle()
  expect(originalFrame).not.toBeNull()
  const expectPreviewPreserved = async () => {
    expect(await display.evaluate((node, original) => node === original, originalFrame!)).toBe(true)
    await expect(page.locator('iframe[title="Rendering Mermaid diagram"]')).toHaveCount(0)
    await expect(diagram.locator('svg')).toBeVisible()
    await expect(diagram.locator('svg')).toContainText('Publish')
    await expect(page.locator('.mermaid-source code')).toBeVisible()
  }
  // Metadata and layout changes rerender App without changing the diagram.
  // Remounting the Markdown renderer would discard both the iframe and the
  // native <details> expansion state, just as periodic sync updates used to.
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Diagram preview stability')
  await expectPreviewPreserved()
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expectPreviewPreserved()
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await expectPreviewPreserved()
  await originalFrame!.dispose()
  await page.screenshot({ path: test.info().outputPath('mermaid-preview.png') })
  await page.getByRole('button', { name: 'Write', exact: true }).click()
  await expect(editor).toHaveValue(source)
  await editor.fill('```mermaid\nthis is not a diagram\n```')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Unable to render this Mermaid diagram', { timeout: 30_000 })
  await page.getByText('Diagram source', { exact: true }).click()
  await expect(page.locator('.mermaid-source code')).toHaveText('this is not a diagram')
  expect(errors).toEqual([])
})
