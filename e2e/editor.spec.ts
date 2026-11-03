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
  await page.getByRole('button', { name: 'Visual', exact: true }).click()
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3)
  await expect(page.getByRole('table').getByRole('columnheader')).toHaveCount(4)
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
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
  await page.getByRole('button', { name: 'Visual', exact: true }).click()
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
  let source = '```mermaid\nflowchart LR\n  Idea --> Draft --> Publish\n```'
  await editor.fill(source)
  await page.getByRole('button', { name: 'Visual', exact: true }).click()
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
  const diagramSource = page.getByRole('textbox', { name: 'Mermaid source', exact: true })
  await diagramSource.focus()
  await diagramSource.press('Control+End')
  await page.keyboard.type(' --> Review')
  await expect(diagramSource).toBeFocused()
  source = source.replace(' --> Publish', ' --> Publish --> Review')
  await expect(diagram.locator('svg')).toContainText('Review')
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
  await expect(editor).toHaveValue(source)
  await editor.fill('```mermaid\nthis is not a diagram\n```')
  await page.getByRole('button', { name: 'Visual', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Unable to render this Mermaid diagram', { timeout: 30_000 })
  await page.getByText('Diagram source', { exact: true }).click()
  await expect(page.locator('.mermaid-source code')).toHaveText('this is not a diagram')
  expect(errors).toEqual([])
})

for (const width of [1440, 390]) {
  test(`Visual edits formatted text and table cells, saves, and preserves untouched Markdown at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/')
    if (width < 768) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await page.getByRole('button', { name: 'New note', exact: true }).first().click()
    const source = '# Heading\n\nA **bold** sentence.\n\n- [ ] A task\n\n| Name | Value |\n| :--- | ---: |\n| Original | 42 |\n\n```js\nconst answer = 42\n```\n'
    const markdown = page.getByRole('textbox', { name: 'Markdown content', exact: true })
    await markdown.fill(source)
    await page.getByRole('button', { name: 'Visual', exact: true }).click()
    const visual = page.getByRole('textbox', { name: 'Visual content', exact: true })
    await expect(visual.getByRole('heading', { name: 'Heading', exact: true })).toBeVisible()
    await expect(visual.locator('strong')).toHaveText('bold')
    // Merely viewing a note must preserve even spacing, fence language and alignment.
    await page.getByRole('button', { name: 'Markdown', exact: true }).click()
    await expect(markdown).toHaveValue(source)
    await page.getByRole('button', { name: 'Visual', exact: true }).click()
    const selectText = async (needle: string, selected: string) => {
      await visual.evaluate((root, { needle, selected }) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          if (!node.textContent?.includes(needle)) continue
          const start = node.textContent.indexOf(selected)
          if (start < 0) continue
          ;(root as HTMLElement).focus()
          const range = document.createRange()
          range.setStart(node, start); range.setEnd(node, start + selected.length)
          const selection = window.getSelection()!
          selection.removeAllRanges(); selection.addRange(range)
          return
        }
        throw new Error(`No visible text containing ${needle}`)
      }, { needle, selected })
    }
    await selectText('sentence.', 'sentence')
    await page.keyboard.insertText('paragraph')
    await expect(visual).toContainText('A bold paragraph.')
    await page.keyboard.press('Control+z')
    await expect(visual).toContainText('A bold sentence.')
    await page.keyboard.press('Control+Shift+z')
    await expect(visual).toContainText('A bold paragraph.')
    await selectText('paragraph.', 'paragraph')
    await page.getByRole('button', { name: 'Bold', exact: true }).click()
    await expect(visual.locator('strong')).toHaveText(['bold', 'paragraph'])
    await visual.getByRole('checkbox').check()
    await selectText('Original', 'Original')
    await page.keyboard.insertText('Changed')
    await expect(visual.getByRole('cell', { name: 'Changed', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath(`visual-editor-${width}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Markdown', exact: true }).click()
    const expected = source.replace('sentence.', '**paragraph**.').replace('- [ ]', '- [x]').replace('Original', 'Changed')
    await expect(markdown).toHaveValue(expected)
    await page.keyboard.press('Control+s')
    await expect(page.getByTitle('Save changes')).toContainText('Saved on this device')
    await page.reload()
    await expect(markdown).toHaveValue(expected)
    expect(errors).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test('Visual supports an empty note, new paragraphs, safe paste, and keyboard deletion', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New note', exact: true }).first().click()
  const markdown = page.getByRole('textbox', { name: 'Markdown content', exact: true })
  await markdown.fill('')
  await page.getByRole('button', { name: 'Visual', exact: true }).click()
  const visual = page.getByRole('textbox', { name: 'Visual content', exact: true })
  await visual.click()
  await page.keyboard.type('First paragraph.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Second paragraph.')
  await expect(visual.locator('p')).toHaveCount(2)
  await page.keyboard.press('Backspace')
  await page.keyboard.type('!')
  await expect(visual.locator('p').last()).toHaveText('Second paragraph!')
  const externalRequests: string[] = []
  page.on('request', request => {
    if (request.url().startsWith('https://visual-paste.invalid/')) externalRequests.push(request.url())
  })
  await visual.evaluate(root => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', ' Pasted safely.')
    transfer.setData('text/html', '<img src="https://visual-paste.invalid/tracker"><script>alert(1)</script> Pasted safely.')
    root.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
  })
  await expect(visual).toContainText('Second paragraph! Pasted safely.')
  await expect(visual.locator('img, script')).toHaveCount(0)
  expect(externalRequests).toEqual([])
  const session = await page.context().newCDPSession(page)
  await session.send('Input.imeSetComposition', { text: ' 日', selectionStart: 2, selectionEnd: 2 })
  await session.send('Input.imeSetComposition', { text: ' 日本語', selectionStart: 4, selectionEnd: 4 })
  await session.send('Input.insertText', { text: ' 日本語' })
  await expect(visual).toContainText('Second paragraph! Pasted safely. 日本語')
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
  await expect(markdown).toHaveValue('First paragraph.\n\nSecond paragraph! Pasted safely. 日本語')
})

test('Visual toolbar creates editable headings and list items from an empty note', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New note', exact: true }).first().click()
  const markdown = page.getByRole('textbox', { name: 'Markdown content', exact: true })
  await markdown.fill('')
  await page.getByRole('button', { name: 'Visual', exact: true }).click()
  const visual = page.getByRole('textbox', { name: 'Visual content', exact: true })
  await page.getByRole('button', { name: 'Heading', exact: true }).click()
  await expect(visual).toBeFocused()
  await page.keyboard.type('A heading')
  await expect(visual.getByRole('heading', { name: 'A heading', exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  await page.keyboard.type('Body text')
  await expect(visual.locator('p')).toContainText('Body text')
  await page.getByRole('button', { name: 'List', exact: true }).click()
  await expect(visual).toBeFocused()
  await page.keyboard.type('First item')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Second item')
  await expect(visual.getByRole('listitem')).toHaveText(['First item', 'Second item'])
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
  await expect(markdown).toHaveValue('\n## A heading\n\nBody text\n\n- First item\n- Second item')
})
