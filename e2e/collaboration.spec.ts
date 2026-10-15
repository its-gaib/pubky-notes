import { expect, test as base } from '@playwright/test'
import type { Browser, BrowserContext, Page } from '@playwright/test'

const BASE = 'http://127.0.0.1:4174'
const BODY = '# Shared draft\n\nMiddle paragraph.\n\nLast paragraph.'
type Peer = { context: BrowserContext; page: Page; owner: string; browserErrors: string[]; iceRequests: () => number }
type Note = { note: { id: string; title: string; content: string; folder?: string; crdt?: { version: number; update: string } }; published: unknown }
type RelayFixture = { firstExpiryMs?: number }
type IceResponse = { iceServers: RTCIceServer[]; relayAvailable: true; expiresAt: number }

const test = base.extend<{ accounts: Peer[] }>({
  accounts: [async ({ browser }, use) => {
    void browser // Keep cleanup ahead of browser teardown, including after test timeouts.
    const accounts: Peer[] = []
    try { await use(accounts) } finally {
      const errors = accounts.flatMap(account => account.browserErrors)
      await cleanup(accounts)
      expect(errors, 'Collaboration must not cause uncaught browser errors or React render loops').toEqual([])
    }
  }, { timeout: 60_000 }],
})

// Provider credentials are short-lived but still should not be captured in traces.
if (process.env.COLLAB_E2E_ICE_ENDPOINT) test.use({ trace: 'off' })

async function relayCredentials(): Promise<IceResponse> {
  const endpoint = process.env.COLLAB_E2E_ICE_ENDPOINT
  if (!endpoint) return {
    iceServers: [{ urls: 'turn:127.0.0.1:3479?transport=udp', username: 'pubky-notes-test', credential: 'local-relay-fixture-only' }],
    relayAvailable: true, expiresAt: Date.now() + 60 * 60 * 1000,
  }
  const fail = () => { throw new Error('Configured ICE endpoint did not return usable temporary TURN credentials.') }
  let url: URL
  try { url = new URL(endpoint) } catch { return fail() }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/api/collaboration-ice'
    || url.search || url.hash || endpoint !== url.href) return fail()
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Origin: url.origin, 'Content-Type': 'application/json', 'X-Pubky-Notes-Collaboration': '1' },
      body: '{}',
    })
    if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
      || Number(response.headers.get('content-length') ?? 0) > 16_384 || !response.body) {
      await response.body?.cancel()
      return fail()
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 16_384) { await reader.cancel(); return fail() }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as Partial<IceResponse>
    if (result?.relayAvailable !== true || typeof result.expiresAt !== 'number' || !Number.isFinite(result.expiresAt)
      || result.expiresAt <= Date.now() + 60_000 || !Array.isArray(result.iceServers)
      || !result.iceServers.length || result.iceServers.length > 16) return fail()
    let hasTurn = false
    const iceServers = result.iceServers.map(server => {
      if (!server || typeof server !== 'object' || Array.isArray(server)) return fail()
      const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
      if (!Array.isArray(urls) || !urls.length || urls.length > 16
        || urls.some(value => typeof value !== 'string' || value.length > 512 || !/^(?:stun|turn|turns):[^\s]+$/.test(value))) return fail()
      const isTurn = urls.some(value => /^turns?:/.test(value))
      if (!isTurn) return { urls }
      const { username, credential } = server
      if (typeof username !== 'string' || !username.length || username.length > 1024
        || typeof credential !== 'string' || !credential.length || credential.length > 2048) return fail()
      hasTurn = true
      return { urls, username, credential }
    })
    if (!hasTurn) return fail()
    return { iceServers, relayAvailable: true, expiresAt: result.expiresAt }
  } catch { return fail() } // Never include provider bodies, headers, or credentials in diagnostics.
}

async function peer(browser: Browser, relayOnly = false, beforeSignIn?: (page: Page) => Promise<void>, relayFixture: RelayFixture = {}): Promise<Peer> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(15_000)
  let issued = 0
  const iceRequests = () => issued
  if (relayOnly) await context.route('**/api/collaboration-ice', async route => {
    const response = await relayCredentials()
    issued++
    if (issued === 1 && relayFixture.firstExpiryMs) response.expiresAt = Math.min(response.expiresAt, Date.now() + relayFixture.firstExpiryMs)
    await route.fulfill({ json: response })
  })
  await context.addInitScript((forceRelay) => {
    const Native = window.RTCPeerConnection
    const connections: RTCPeerConnection[] = [], channels: RTCDataChannel[] = []
    const state = Object.assign(window, { __testConnections: connections, __testChannels: channels, __testDroppedHandshake: 0 })
    if (forceRelay) {
      const nativeSend = RTCDataChannel.prototype.send
      RTCDataChannel.prototype.send = function (data) {
        // Deliberately lose each browser's first handshake. Everything afterward
        // uses the actual browser SCTP channel and the configured TURN server.
        if (this.label === 'pubky-notes-v1' && state.__testDroppedHandshake === 0) {
          state.__testDroppedHandshake++
          return
        }
        return Reflect.apply(nativeSend, this, [data])
      }
    }
    window.RTCPeerConnection = class extends Native {
      constructor(configuration?: RTCConfiguration) {
        super(forceRelay ? { ...configuration, iceTransportPolicy: 'relay' } : configuration)
        connections.push(this)
        this.addEventListener('datachannel', event => channels.push(event.channel))
      }
      override createDataChannel(label: string, options?: RTCDataChannelInit) {
        const channel = super.createDataChannel(label, options)
        channels.push(channel)
        return channel
      }
    }
  }, relayOnly)
  const page = await context.newPage()
  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('Maximum update depth exceeded')) browserErrors.push(message.text())
  })
  try {
    await beforeSignIn?.(page)
    await page.goto(`${BASE}/e2e/fixture.html`)
    const owner = await page.evaluate(async () => {
      const path = '/e2e/browser-account.ts'
      return (await import(/* @vite-ignore */ path)).createAccount()
    })
    await page.goto(BASE)
    await expect(page.getByRole('button', { name: 'Disconnect from Pubky' })).toBeVisible()
    return { context, page, owner, browserErrors, iceRequests }
  } catch (error) {
    await cleanup([{ context, page, owner: '', browserErrors, iceRequests }])
    throw error
  }
}

async function notes(page: Page): Promise<Note[]> {
  return page.evaluate(async () => {
    const path = '/e2e/browser-account.ts'
    return (await import(/* @vite-ignore */ path)).readNotes()
  })
}

async function cleanup(peers: Peer[]) {
  const failures: unknown[] = []
  const unloaded = new Set<Page>()
  // Disconnect waits for the current homeserver save to release its lock.
  // Navigating away first can abort that save before its finally block runs.
  for (const { page, context } of peers) {
    try {
      await context.setOffline(false)
      const disconnect = page.getByRole('button', { name: 'Disconnect from Pubky', includeHidden: true })
      if (await disconnect.count()) {
        await expect(disconnect).toBeEnabled()
        // The account button is in the collapsed sidebar at phone widths.
        await disconnect.evaluate(button => (button as HTMLButtonElement).click())
        await expect(disconnect).toHaveCount(0)
      }
      await page.goto(`${BASE}/e2e/fixture.html`)
      unloaded.add(page)
    } catch (error) { failures.push(error) }
  }
  // Both apps are stopped before any disposable account files are removed.
  for (const { page, context } of peers) {
    try {
      if (!unloaded.has(page)) continue
      await page.evaluate(async () => {
        const path = '/e2e/browser-account.ts'
        try { await (await import(/* @vite-ignore */ path)).cleanAccount() }
        catch (error) {
          const describe = (value: unknown): string => value instanceof AggregateError
            ? `${value.message}: ${value.errors.map(describe).join('; ')}`
            : value instanceof Error ? `${value.name}: ${value.message}` : String(value)
          throw new Error(describe(error))
        }
      })
    } catch (error) { failures.push(error) }
    finally { await context.close() }
  }
  if (failures.length) throw new AggregateError(failures, 'Browser test cleanup failed.')
}

async function connected(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const state = window as typeof window & { __testChannels: RTCDataChannel[]; __testConnections: RTCPeerConnection[] }
    return state.__testChannels.some(channel => channel.readyState === 'open')
      && state.__testConnections.some(connection => connection.connectionState === 'connected')
  }), { message: 'An actual WebRTC data channel must open' }).toBe(true)
}

async function relayed(page: Page, firstConnection = 0) {
  await expect.poll(() => page.evaluate(async first => {
    const state = window as typeof window & { __testConnections: RTCPeerConnection[] }
    for (const connection of state.__testConnections.slice(first)) {
      if (connection.connectionState !== 'connected') continue
      const stats = await connection.getStats()
      for (const report of stats.values()) {
        if (report.type !== 'candidate-pair' || report.state !== 'succeeded' || !report.nominated) continue
        if (stats.get(report.localCandidateId)?.candidateType === 'relay'
          && stats.get(report.remoteCandidateId)?.candidateType === 'relay') return true
      }
    }
    return false
  }, firstConnection), { message: 'Both selected ICE candidates must be actual TURN relay allocations' }).toBe(true)
}

async function createInvitation(alice: Page) {
  await alice.getByRole('button', { name: 'New note', exact: true }).first().click()
  await alice.getByRole('textbox', { name: 'Note title' }).fill('E2E shared draft')
  await alice.getByRole('textbox', { name: 'Markdown content' }).fill('DELETED PRIVATE TEXT MUST NOT BE SHARED')
  await alice.getByRole('textbox', { name: 'Markdown content' }).fill(BODY)
  await alice.getByRole('button', { name: 'Collaborate', exact: true }).click()
  await expect(alice.getByRole('region', { name: 'Collaboration', exact: true })).toBeVisible()
  await expect(alice.getByRole('dialog')).toHaveCount(0)
  await alice.getByRole('button', { name: 'Create shared copy' }).click()
  const invitation = alice.getByRole('textbox', { name: 'Invitation link' })
  await expect(invitation).toBeVisible()
  const link = await invitation.inputValue()
  const encoded = new URL(link).hash.slice('#collaborate='.length)
  const id = JSON.parse(Buffer.from(decodeURIComponent(encoded), 'base64url').toString()).descriptor.id as string
  await alice.getByRole('textbox', { name: 'Markdown content' }).focus()
  return { id, link }
}

async function acceptInvitation(alice: Page, bob: Page) {
  const [hostOwner, guestOwner] = await Promise.all([alice, bob].map(page =>
    page.evaluate(() => localStorage.getItem('pubky-notes:e2e:disposable-account'))))
  expect(hostOwner).toBeTruthy()
  expect(guestOwner).toBeTruthy()
  await expect(bob.getByRole('region', { name: 'Collaboration', exact: true })).toBeVisible()
  await expect(bob.getByRole('dialog')).toHaveCount(0)
  await bob.getByRole('button', { name: 'Join collaboration', exact: true }).click()
  await expect(alice.getByRole('button', { name: 'Allow collaborator' })).toBeVisible()
  await expect(alice.getByRole('button', { name: 'Copy verified Pubky identifier' })).toHaveText(`pubky${guestOwner}`)
  await expect(bob.getByRole('button', { name: 'Copy verified Pubky identifier' })).toHaveText(`pubky${hostOwner}`)
  await expect(alice.getByText('You don’t follow this person.')).toBeVisible()
  await expect(bob.getByText('You don’t follow this person.')).toBeVisible()
  if (test.info().title.startsWith('shared history')) {
    await alice.screenshot({ path: test.info().outputPath('verified-approval-desktop.png'), fullPage: true })
    const previousViewport = bob.viewportSize()!
    await bob.setViewportSize({ width: 390, height: 844 })
    expect(await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await bob.screenshot({ path: test.info().outputPath('verified-inviter-phone.png'), fullPage: true })
    await bob.setViewportSize(previousViewport)
  }
  await expect(alice.getByRole('textbox', { name: 'Markdown content' })).toBeFocused()
  await expect(alice.getByRole('dialog')).toHaveCount(0)
  // Approval is an actual authorization boundary: no document or peer channel yet.
  expect(await notes(bob)).toEqual([])
  await expect(bob.getByRole('textbox', { name: 'Markdown content' })).toHaveCount(0)
  expect(await bob.evaluate(() => (window as typeof window & { __testChannels: RTCDataChannel[] }).__testChannels.length)).toBe(0)
  expect(new URL(bob.url()).hash).toBe('')
  await alice.getByRole('button', { name: 'Allow collaborator' }).click()
  await Promise.all([connected(alice), connected(bob)])
  await Promise.all([alice, bob].map(async page => {
    await expect(page.getByRole('region', { name: 'Collaboration', exact: true })).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    try { await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(BODY) }
    catch (error) {
      const diagnostics = await page.evaluate(async () => {
        const state = window as typeof window & { __testConnections: RTCPeerConnection[] }
        const connections = []
        for (const connection of state.__testConnections) {
          const stats = await connection.getStats()
          connections.push({ state: connection.connectionState,
            channels: [...stats.values()].filter(report => report.type === 'data-channel') })
        }
        return { connections, messages: [...document.querySelectorAll('.toast, .inline-error, .collaboration-status')].map(node => node.textContent) }
      })
      await test.info().attach('connection-diagnostics', { body: JSON.stringify(diagnostics), contentType: 'application/json' })
      throw error
    }
  }))
}

async function share(alice: Page, bob: Page) {
  const { id, link } = await createInvitation(alice)
  await bob.goto(link)
  await acceptInvitation(alice, bob)
  return id
}

async function saved(page: Page, id: string, content: string) {
  await expect.poll(async () => (await notes(page)).find(row => row.note.id === id)?.note.content,
    { message: 'The actual private homeserver file must contain the converged text' }).toBe(content)
}

async function insert(page: Page, edge: 'start' | 'end', text: string) {
  const editor = page.getByRole('textbox', { name: 'Markdown content' })
  await editor.focus()
  await editor.press(edge === 'start' ? 'Control+Home' : 'Control+End')
  await page.keyboard.insertText(text)
}

async function selectText(page: Page, start: number, end = start, direction: 'forward' | 'backward' | 'none' = 'forward') {
  const editor = page.getByRole('textbox', { name: 'Markdown content' })
  await editor.focus()
  const value = await editor.inputValue(), backward = direction === 'backward'
  // Native keydown invalidates older restoration before the browser moves the
  // selection. A direct setSelectionRange followed by a key event leaves a race.
  if (start === 0 && end === value.length) {
    await editor.press(backward ? 'Control+End' : 'Control+Home')
    await page.keyboard.press(backward ? 'Control+Shift+Home' : 'Control+Shift+End')
  } else {
    await editor.press('Control+Home')
    for (const _ of Array.from(value.slice(0, backward ? end : start))) await page.keyboard.press('ArrowRight')
    if (start !== end) {
      await page.keyboard.down('Shift')
      try {
        for (const _ of Array.from(value.slice(start, end))) await page.keyboard.press(backward ? 'ArrowLeft' : 'ArrowRight')
      } finally { await page.keyboard.up('Shift') }
    }
  }
  await expect.poll(() => editor.evaluate(element => {
    const input = element as HTMLTextAreaElement
    return [input.selectionStart, input.selectionEnd]
  })).toEqual([start, end])
}

async function overlaysStayInsideEditor(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const editor = document.querySelector<HTMLTextAreaElement>('[aria-label="Markdown content"]')!
    const box = editor.getBoundingClientRect()
    const overlays = [...document.querySelectorAll<HTMLElement>('.remote-selection-caret, .remote-selection-highlight, .remote-selection-name')]
      .filter(element => getComputedStyle(element).visibility !== 'hidden')
    return overlays.length > 0 && overlays.every(element => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && rect.left >= box.left - 1 && rect.top >= box.top - 1
        && rect.right <= box.right + 1 && rect.bottom <= box.bottom + 1
    })
  }), { message: 'Remote cursor, name, and selection must remain clipped to the textarea' }).toBe(true)
}

test('approved browsers exchange real RTC edits, keep independent private files, and stop on logout', async ({ browser, accounts: peers }) => {
    const alice = await peer(browser); peers.push(alice)
    const bob = await peer(browser); peers.push(bob)
    expect(alice.owner).not.toBe(bob.owner)
    const id = await share(alice.page, bob.page)
    await Promise.all([insert(alice.page, 'start', 'Alice 📝\n'), insert(bob.page, 'end', '\nBob café')])
    const merged = `Alice 📝\n${BODY}\nBob café`
    for (const { page } of peers) await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(merged)
    await Promise.all(peers.map(({ page }) => saved(page, id, merged)))
    for (const { page } of peers) {
      const row = (await notes(page)).find(row => row.note.id === id)!
      expect(row.published).toBeNull()
      expect(row.note.crdt?.version).toBe(2)
      expect(Buffer.from(row.note.crdt!.update, 'base64').toString()).not.toContain('DELETED PRIVATE TEXT MUST NOT BE SHARED')
      await expect(page.locator(`[data-note-id="${id}"]`).getByLabel('Private note', { exact: true })).toBeVisible()
    }

    await alice.page.getByRole('button', { name: 'New folder', exact: true }).click()
    await alice.page.getByRole('textbox', { name: 'Folder name' }).fill('Alice only')
    await alice.page.getByRole('button', { name: 'Create folder', exact: true }).click()
    await alice.page.getByRole('button', { name: 'Folder actions for Alice only', exact: true }).click()
    await alice.page.getByRole('menuitem', { name: 'New subfolder', exact: true }).click()
    await alice.page.getByRole('textbox', { name: 'Folder name' }).fill('Research')
    await alice.page.getByRole('button', { name: 'Create folder', exact: true }).click()
    await alice.page.getByRole('button', { name: 'Notes', exact: true }).click()
    await alice.page.locator(`[data-note-id="${id}"]`).getByRole('button', { name: 'Note actions for E2E shared draft', exact: true }).click()
    await alice.page.getByRole('menuitem', { name: 'Move to…' }).click()
    await alice.page.getByRole('combobox', { name: 'Move note to', exact: true }).selectOption('Alice only/Research')
    await expect(alice.page.getByRole('dialog')).toHaveCount(0)
    await alice.page.getByRole('button', { name: 'Move', exact: true }).click()
    await expect.poll(async () => (await notes(alice.page)).find(row => row.note.id === id)?.note.folder).toBe('Alice only/Research')
    expect((await notes(bob.page)).find(row => row.note.id === id)?.note.folder || '').toBe('')
    await expect(bob.page.getByRole('button', { name: 'Open folder Alice only/Research' })).toHaveCount(0)

    await alice.page.getByRole('button', { name: 'Share', exact: true }).click()
    await alice.page.getByRole('button', { name: 'Publish public copy' }).click()
    await expect.poll(async () => (await notes(alice.page)).find(row => row.note.id === id)?.published).not.toBeNull()
    await expect(alice.page.locator(`[data-note-id="${id}"]`).getByLabel('Public copy published', { exact: true })).toBeVisible()
    expect((await notes(bob.page)).find(row => row.note.id === id)?.published).toBeNull()
    await expect(bob.page.locator(`[data-note-id="${id}"]`).getByLabel('Private note', { exact: true })).toBeVisible()
    await alice.page.getByRole('button', { name: 'Unpublish', exact: true }).click()
    // A snapshot can list the public file just before Unpublish removes it.
    // Retry the complete read, including that transient GET404, until it is absent.
    await expect(async () => expect((await notes(alice.page)).find(row => row.note.id === id)?.published).toBeNull()).toPass({ timeout: 20_000 })
    await expect(alice.page.locator(`[data-note-id="${id}"]`).getByLabel('Private note', { exact: true })).toBeVisible()
    await alice.page.getByRole('button', { name: 'Close dialog' }).click()
    await connected(bob.page)

    await bob.page.getByRole('button', { name: 'Disconnect from Pubky' }).click()
    await expect(bob.page.getByRole('button', { name: 'Disconnect from Pubky' })).toHaveCount(0)
    await expect.poll(() => bob.page.evaluate(() => (window as typeof window & { __testChannels: RTCDataChannel[] }).__testChannels.every(channel => channel.readyState === 'closed'))).toBe(true)
    await insert(alice.page, 'end', '\nAfter Bob signed out')
    expect((await notes(bob.page)).find(row => row.note.id === id)?.note.content).toBe(merged)
})

test('shared history shows who added and removed text across both browsers and reload', async ({ browser, accounts: peers }) => {
  const alice = await peer(browser); peers.push(alice)
  const bob = await peer(browser); peers.push(bob)
  const id = await share(alice.page, bob.page)
  const aliceLine = '\nAlice authored this line.'
  await insert(alice.page, 'end', aliceLine)
  await expect(bob.page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(BODY + aliceLine)
  for (const { page } of peers) await page.keyboard.press('Control+s')
  await Promise.all(peers.map(({ page }) => saved(page, id, BODY + aliceLine)))
  // Bob removes Alice's entire addition. Deletion ownership must be Bob's.
  await bob.page.getByRole('textbox', { name: 'Markdown content' }).fill(BODY)
  await expect(alice.page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(BODY)
  for (const { page } of peers) await page.keyboard.press('Control+s')
  await Promise.all(peers.map(({ page }) => saved(page, id, BODY)))
  for (const { page } of peers) {
    await page.reload()
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(BODY)
    if (page === bob.page) await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Version history', exact: true }).click()
    const slider = page.getByRole('slider', { name: 'Version timeline' })
    const changes = page.getByRole('article', { name: 'Version changes' })
    const bobEdits = changes.getByRole('region', { name: `Edits by Editor ${bob.owner.slice(-12)}`, exact: true })
    await expect(bobEdits.locator('del')).toContainText('Alice authored this line.')
    const last = Number(await slider.getAttribute('max'))
    let foundAlice = false
    for (let index = 1; index < last; index++) {
      await slider.fill(String(index))
      const aliceEdits = changes.getByRole('region', { name: `Edits by Editor ${alice.owner.slice(-12)}`, exact: true })
      if (await aliceEdits.count()) {
        await expect(aliceEdits.locator('ins')).toContainText('Alice authored this line.')
        foundAlice = true
      }
    }
    expect(foundAlice).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`history-attribution-${peers.indexOf(peers.find(peer => peer.page === page)!)}.png`), fullPage: true })
  }
})

test('unavailable WebRTC explains the browser problem before sharing a private note', async ({ browser, accounts: peers }) => {
  const alice = await peer(browser); peers.push(alice)
  await alice.page.getByRole('button', { name: 'New note', exact: true }).first().click()
  await alice.page.getByRole('textbox', { name: 'Markdown content' }).fill('Original remains private')
  await alice.page.keyboard.press('Control+s')
  await expect.poll(async () => (await notes(alice.page)).length).toBe(1)
  await alice.page.evaluate(() => { Object.defineProperty(window, 'RTCPeerConnection', { value: undefined, configurable: true }) })
  await alice.page.getByRole('button', { name: 'Collaborate', exact: true }).click()
  await alice.page.getByRole('button', { name: 'Create shared copy' }).click()
  await expect(alice.page.getByRole('alert')).toContainText('WebRTC')
  expect((await notes(alice.page)).length).toBe(1)
  expect((await notes(alice.page))[0].note.crdt?.version).toBe(1)
  await expect(alice.page.getByRole('textbox', { name: 'Invitation link' })).toHaveCount(0)
})

test('pending invitation survives sign-in and reload until the recipient explicitly joins', async ({ browser, accounts: peers }) => {
  const alice = await peer(browser); peers.push(alice)
  const { id, link } = await createInvitation(alice.page)
  const bob = await peer(browser, false, async page => {
    await page.goto(link)
    await expect(page.getByRole('button', { name: 'Connect Pubky to join', exact: true })).toBeVisible()
    expect(new URL(page.url()).hash).toBe('')
    await page.reload()
    await expect(page.getByRole('button', { name: 'Connect Pubky to join', exact: true })).toBeVisible()
    expect(new URL(page.url()).hash).toBe('')
    await expect(alice.page.getByRole('button', { name: 'Allow collaborator' })).toHaveCount(0)
    // peer() now signs in a fresh disposable identity on the fixture page and
    // returns to the app without an invitation fragment, in this same tab.
  }); peers.push(bob)
  expect(new URL(bob.page.url()).hash).toBe('')
  await expect(bob.page.getByRole('button', { name: 'Join collaboration', exact: true })).toBeVisible()
  await bob.page.reload()
  await expect(bob.page.getByRole('button', { name: 'Join collaboration', exact: true })).toBeVisible()
  expect(await notes(bob.page)).toEqual([])
  await expect(alice.page.getByRole('button', { name: 'Allow collaborator' })).toHaveCount(0)
  await acceptInvitation(alice.page, bob.page)
  await insert(bob.page, 'end', '\nJoined after signing in.')
  const merged = `${BODY}\nJoined after signing in.`
  for (const { page } of peers) await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(merged)
  await Promise.all(peers.map(({ page }) => saved(page, id, merged)))
  await bob.page.reload()
  await connected(bob.page)
  await expect(bob.page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(merged)
  await expect(bob.page.getByRole('button', { name: 'Join collaboration', exact: true })).toHaveCount(0)
  await expect(bob.page.getByRole('button', { name: 'Connect Pubky to join', exact: true })).toHaveCount(0)
  await expect(alice.page.getByRole('button', { name: 'Allow collaborator' })).toHaveCount(0)
})

test('offline branches merge on reconnection and reload reuses the approved browser identity', async ({ browser, accounts: peers }) => {
    const alice = await peer(browser); peers.push(alice)
    const bob = await peer(browser); peers.push(bob)
    const id = await share(alice.page, bob.page)
    await Promise.all(peers.map(({ page }) => saved(page, id, BODY)))
    // Browser offline mode does not reliably close an existing UDP connection.
    // Close the genuine channel as well to model a broken transport, without a fake provider.
    await bob.context.setOffline(true)
    await bob.page.evaluate(() => {
      const state = window as typeof window & { __testChannels: RTCDataChannel[]; __testConnections: RTCPeerConnection[] }
      state.__testChannels.forEach(channel => channel.close())
      state.__testConnections.forEach(connection => connection.close())
    })
    await insert(bob.page, 'end', '\nBob edited offline')
    await insert(alice.page, 'start', 'Alice while Bob was away\n')
    await expect(bob.page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(`${BODY}\nBob edited offline`)
    await expect(alice.page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(`Alice while Bob was away\n${BODY}`)
    await bob.context.setOffline(false)
    await Promise.all(peers.map(({ page }) => connected(page)))
    const merged = `Alice while Bob was away\n${BODY}\nBob edited offline`
    for (const { page } of peers) await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(merged)
    await Promise.all(peers.map(({ page }) => saved(page, id, merged)))

    await Promise.all(peers.map(({ page }) => page.reload()))
    await Promise.all(peers.map(({ page }) => connected(page)))
    for (const { page } of peers) {
      await expect(page.getByRole('button', { name: 'Allow collaborator' })).toHaveCount(0)
      await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(merged)
    }
    await insert(bob.page, 'end', '\nAfter reload')
    await expect(alice.page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(`${merged}\nAfter reload`)
    await Promise.all(peers.map(({ page }) => saved(page, id, `${merged}\nAfter reload`)))
})

test('live collaborator cursors follow native selections, CRDT edits, wrapping, and scrolling without persisting presence', async ({ browser, accounts: peers }) => {
  const alice = await peer(browser); peers.push(alice)
  const bob = await peer(browser); peers.push(bob)
  const id = await share(alice.page, bob.page)
  await Promise.all([insert(alice.page, 'start', 'Alice\n'), insert(bob.page, 'end', '\nBob')])
  const merged = `Alice\n${BODY}\nBob`
  await Promise.all(peers.map(async ({ page }) => {
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(merged)
    await saved(page, id, merged)
  }))
  const beforePresence = await Promise.all(peers.map(async ({ page }) => (await notes(page)).find(row => row.note.id === id)))
  const aliceEditor = alice.page.getByRole('textbox', { name: 'Markdown content' })
  const bobEditor = bob.page.getByRole('textbox', { name: 'Markdown content' })
  const caret = alice.page.locator('.remote-selection-caret')
  const label = alice.page.locator('.remote-selection-name')
  const highlights = alice.page.locator('.remote-selection-highlight')

  await bobEditor.focus()
  await bobEditor.press('Control+Home')
  await bobEditor.press('ArrowRight')
  await expect(caret).toBeVisible()
  await expect(label).toBeVisible()
  await expect(label).toHaveText(/^Collaborator /)
  // The preceding edit already left a visible cursor at the end of "Bob".
  // Wait for Home + Right to propagate before sampling its new position.
  const firstCharacterX = await aliceEditor.evaluate(element => {
    const editor = element as HTMLTextAreaElement
    const style = getComputedStyle(editor), context = document.createElement('canvas').getContext('2d')!
    context.font = `${style.fontSize} ${style.fontFamily}`
    return editor.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
      - editor.scrollLeft + context.measureText(editor.value.slice(0, 1)).width
  })
  await expect.poll(async () => Math.abs(((await caret.boundingBox())?.x ?? Infinity) - firstCharacterX),
    { message: 'The remote caret must reach the first character before measuring movement' }).toBeLessThan(2)
  const firstCaret = (await caret.boundingBox())!
  await bobEditor.press('ArrowRight')
  await expect.poll(async () => (await caret.boundingBox())?.x ?? 0).toBeGreaterThan(firstCaret.x + 5)
  await bobEditor.press('Shift+ArrowRight')
  await expect(highlights).toHaveCount(1)
  await overlaysStayInsideEditor(alice.page)
  await expect(aliceEditor).toHaveValue(merged)
  await expect(bobEditor).toHaveValue(merged)
  const afterPresence = await Promise.all(peers.map(async ({ page }) => (await notes(page)).find(row => row.note.id === id)))
  expect(afterPresence).toEqual(beforePresence)

  const selectedStart = merged.indexOf('Middle')
  await selectText(bob.page, selectedStart, selectedStart + 'Middle'.length)
  await expect(highlights).toHaveCount(1)
  // Wait for the selection to leave the first line before sampling its position.
  await expect.poll(async () => (await highlights.first().boundingBox())?.y ?? 0).toBeGreaterThan(firstCaret.y + 30)
  const selectedWidth = await aliceEditor.evaluate(element => {
    const style = getComputedStyle(element), context = document.createElement('canvas').getContext('2d')!
    context.font = `${style.fontSize} ${style.fontFamily}`
    return context.measureText('Middle').width
  })
  // Native Shift+Right emits intermediate ranges; sample only the complete word.
  await expect.poll(async () => Math.abs(((await highlights.first().boundingBox())?.width ?? 0) - selectedWidth)).toBeLessThan(2)
  const beforeInsert = (await highlights.first().boundingBox())!
  const prefix = 'Prefix '
  const prefixWidth = await aliceEditor.evaluate((element, text) => {
    const style = getComputedStyle(element), context = document.createElement('canvas').getContext('2d')!
    context.font = `${style.fontSize} ${style.fontFamily}`
    return context.measureText(text).width
  }, prefix)
  await selectText(alice.page, selectedStart)
  await alice.page.keyboard.insertText(prefix)
  const anchored = merged.slice(0, selectedStart) + prefix + merged.slice(selectedStart)
  await expect(bobEditor).toHaveValue(anchored)
  await expect.poll(() => bobEditor.evaluate(element => {
    const editor = element as HTMLTextAreaElement
    return editor.value.slice(editor.selectionStart, editor.selectionEnd)
  })).toBe('Middle')
  await expect.poll(async () => {
    const box = await highlights.first().boundingBox()
    return box ? Math.abs(box.x - beforeInsert.x - prefixWidth) : Infinity
  }, { message: 'The remote selection must stay anchored to Middle after an insertion before it' }).toBeLessThan(3)
  expect(Math.abs((await highlights.first().boundingBox())!.width - beforeInsert.width)).toBeLessThan(3)

  const longText = `Wrapped ${'word '.repeat(110)}\n\n${Array.from({ length: 60 }, (_, index) => `Line ${index}: scrollable shared text.`).join('\n')}`
  await aliceEditor.fill(longText)
  await expect(bobEditor).toHaveValue(longText)
  await aliceEditor.evaluate(element => { element.scrollTop = 0 })
  await selectText(bob.page, 0, 450)
  await expect.poll(() => highlights.count()).toBeGreaterThan(1)
  await expect(caret).toBeVisible()
  await overlaysStayInsideEditor(alice.page)
  {
    const border = alice.page.getByRole('separator', { name: 'Resize sidebar', exact: true })
    const pane = alice.page.locator('.navigation-pane')
    const originalWidth = (await pane.boundingBox())!.width
    const originalCaret = (await caret.boundingBox())!
    for (const delta of [80, -80]) {
      const box = (await border.boundingBox())!
      const x = box.x + box.width / 2, y = box.y + box.height / 4
      await alice.page.mouse.move(x, y)
      await alice.page.mouse.down()
      await alice.page.mouse.move(x + delta, y, { steps: 10 })
      await alice.page.mouse.up()
      await expect.poll(async () => Math.abs((await pane.boundingBox())!.width - (originalWidth + (delta > 0 ? 80 : 0)))).toBeLessThan(1)
      await overlaysStayInsideEditor(alice.page)
      if (delta > 0) await expect.poll(async () => {
        const position = await caret.boundingBox()
        return position ? Math.abs(position.x - originalCaret.x) + Math.abs(position.y - originalCaret.y) : 0
      }).toBeGreaterThan(10)
    }
  }
  const beforeResize = (await caret.boundingBox())!
  await alice.page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect.poll(async () => {
    const box = await caret.boundingBox()
    return box ? Math.abs(box.x - beforeResize.x) + Math.abs(box.y - beforeResize.y) : 0
  }).toBeGreaterThan(20)
  await overlaysStayInsideEditor(alice.page)
  await alice.page.screenshot({ path: '/tmp/pubky-notes-live-cursors-desktop.png' })
  await alice.page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await overlaysStayInsideEditor(alice.page)

  await bobEditor.press('Control+End')
  await aliceEditor.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(caret).toBeVisible()
  await overlaysStayInsideEditor(alice.page)
  await aliceEditor.evaluate(element => { element.scrollTop = 0 })
  await expect(caret).toHaveCount(0)
  await expect(label).toBeHidden()
  await selectText(bob.page, 0, longText.length)
  await aliceEditor.evaluate(element => { element.scrollTop = element.scrollHeight / 2 })
  await expect.poll(() => highlights.count()).toBeGreaterThan(2)
  await overlaysStayInsideEditor(alice.page)
  await expect(caret).toHaveCount(0)

  await bob.page.getByRole('textbox', { name: 'Note title' }).focus()
  await expect(highlights).toHaveCount(0)
  await expect(label).toBeHidden()
  await aliceEditor.evaluate(element => { element.scrollTop = 0 })
  await selectText(bob.page, 3)
  await expect(caret).toBeVisible()
  await bob.page.getByRole('button', { name: 'New note', exact: true }).first().click()
  await expect(caret).toHaveCount(0)
  await expect(label).toBeHidden()
  await bob.page.getByRole('button', { name: 'Open note E2E shared draft', exact: true }).click()
  await selectText(bob.page, 3)
  await expect(caret).toBeVisible()
  await Promise.all(peers.map(({ page }) => saved(page, id, longText)))
  await bob.page.getByRole('button', { name: 'Disconnect from Pubky' }).click()
  await expect(caret).toHaveCount(0)
  await expect(highlights).toHaveCount(0)
  await expect(label).toBeHidden()
  await expect(aliceEditor).toHaveValue(longText)
})

test('real TURN collaboration recovers a lost initial handshake when direct ICE is disabled', async ({ browser, accounts: peers }) => {
    const alice = await peer(browser, true); peers.push(alice)
    const bob = await peer(browser, true); peers.push(bob)
    const id = await share(alice.page, bob.page)
    for (const { page } of peers) {
      expect(await page.evaluate(() => (window as typeof window & { __testDroppedHandshake: number }).__testDroppedHandshake)).toBe(1)
      await relayed(page)
    }
    await insert(alice.page, 'end', '\nDelivered through TURN')
    await expect(bob.page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(`${BODY}\nDelivered through TURN`)
    await Promise.all(peers.map(({ page }) => saved(page, id, `${BODY}\nDelivered through TURN`)))
})

test('real TURN collaboration renews credentials and replaces allocations without another approval', async ({ browser, accounts: peers }) => {
  // Only the response metadata is shortened. The browser still uses real TURN
  // credentials and allocations; this exercises renewal without a ten-minute wait.
  const alice = await peer(browser, true, undefined, { firstExpiryMs: 90_000 }); peers.push(alice)
  const bob = await peer(browser, true, undefined, { firstExpiryMs: 90_000 }); peers.push(bob)
  const id = await share(alice.page, bob.page)
  await Promise.all(peers.map(({ page }) => relayed(page)))
  await insert(alice.page, 'end', '\nBefore credential renewal')
  const before = `${BODY}\nBefore credential renewal`
  await expect(bob.page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(before)
  await Promise.all(peers.map(({ page }) => saved(page, id, before)))
  const originalConnections = await Promise.all(peers.map(({ page }) => page.evaluate(() =>
    (window as typeof window & { __testConnections: RTCPeerConnection[] }).__testConnections.length)))
  expect(originalConnections.every(count => count > 0)).toBe(true)

  // TTL90s renews60s early: allow the real timer to run, with no clock mocks.
  await expect.poll(() => peers.every(account => account.iceRequests() >= 2), {
    timeout: 45_000, message: 'Both peers must obtain fresh TURN credentials before the initial advertised expiry',
  }).toBe(true)
  await Promise.all(peers.map(async ({ page }, index) => {
    await expect.poll(() => page.evaluate(count => {
      const connections = (window as typeof window & { __testConnections: RTCPeerConnection[] }).__testConnections
      return connections.length > count && connections.slice(0, count).every(connection => connection.connectionState === 'closed')
    }, originalConnections[index]), { message: 'Renewal must close the old RTCPeerConnection and construct a replacement' }).toBe(true)
    await connected(page)
    await relayed(page, originalConnections[index])
    await expect(page.getByRole('button', { name: 'Allow collaborator' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Join collaboration', exact: true })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(before)
  }))

  await Promise.all([insert(alice.page, 'start', 'Alice after renewal\n'), insert(bob.page, 'end', '\nBob after renewal')])
  const merged = `Alice after renewal\n${before}\nBob after renewal`
  for (const { page } of peers) await expect(page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(merged)
  await Promise.all(peers.map(({ page }) => saved(page, id, merged)))
})
