import { expect, test as base } from '@playwright/test'
import type { Browser, BrowserContext, Page } from '@playwright/test'

const BASE = 'http://127.0.0.1:4174'
const BODY = '# Shared draft\n\nMiddle paragraph.\n\nLast paragraph.'
type Peer = { context: BrowserContext; page: Page; owner: string }
type Note = { note: { id: string; title: string; content: string; folder?: string; crdt?: { version: number; update: string } }; published: unknown }

const test = base.extend<{ accounts: Peer[] }>({
  accounts: [async ({ browser }, use) => {
    void browser // Keep cleanup ahead of browser teardown, including after test timeouts.
    const accounts: Peer[] = []
    try { await use(accounts) } finally { await cleanup(accounts) }
  }, { timeout: 60_000 }],
})

async function peer(browser: Browser, relayOnly = false): Promise<Peer> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(15_000)
  if (relayOnly) await context.route('**/api/collaboration-ice', route => route.fulfill({ json: {
    iceServers: [{ urls: 'turn:127.0.0.1:3479?transport=udp', username: 'pubky-notes-test', credential: 'local-relay-fixture-only' }],
    relayAvailable: true, expiresAt: Date.now() + 60 * 60 * 1000,
  } }))
  await context.addInitScript((forceRelay) => {
    const Native = window.RTCPeerConnection
    const connections: RTCPeerConnection[] = [], channels: RTCDataChannel[] = []
    const state = Object.assign(window, { __testConnections: connections, __testChannels: channels, __testDroppedHandshake: 0 })
    if (forceRelay) {
      const nativeSend = RTCDataChannel.prototype.send
      RTCDataChannel.prototype.send = function (data) {
        // Deliberately lose each browser's first handshake. Everything afterward
        // uses the actual browser SCTP channel and the actual loopback TURN server.
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
  try {
    await page.goto(`${BASE}/e2e/fixture.html`)
    const owner = await page.evaluate(async () => {
      const path = '/e2e/browser-account.ts'
      return (await import(/* @vite-ignore */ path)).createAccount()
    })
    await page.goto(BASE)
    await expect(page.getByRole('button', { name: 'Disconnect from Pubky' })).toBeVisible()
    return { context, page, owner }
  } catch (error) {
    await cleanup([{ context, page, owner: '' }])
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
  for (const { page, context } of peers) {
    try {
      await context.setOffline(false)
      // Unload the app before deleting files so autosave cannot recreate them.
      await page.goto(`${BASE}/e2e/fixture.html`)
      await page.evaluate(async () => {
        const path = '/e2e/browser-account.ts'
        await (await import(/* @vite-ignore */ path)).cleanAccount()
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

async function share(alice: Page, bob: Page) {
  await alice.getByRole('button', { name: 'New note', exact: true }).first().click()
  await alice.getByRole('textbox', { name: 'Note title' }).fill('E2E shared draft')
  await alice.getByRole('textbox', { name: 'Markdown content' }).fill('DELETED PRIVATE TEXT MUST NOT BE SHARED')
  await alice.getByRole('textbox', { name: 'Markdown content' }).fill(BODY)
  await alice.getByRole('button', { name: 'Collaborate', exact: true }).click()
  await alice.getByRole('button', { name: 'Create shared copy' }).click()
  const invitation = alice.getByRole('textbox', { name: 'Invitation link' })
  await expect(invitation).toBeVisible()
  const link = await invitation.inputValue()
  const encoded = new URL(link).hash.slice('#collaborate='.length)
  const id = JSON.parse(Buffer.from(decodeURIComponent(encoded), 'base64url').toString()).descriptor.id as string
  await bob.goto(link)
  await bob.getByRole('button', { name: 'Join collaboration', exact: true }).click()
  await expect(alice.getByRole('button', { name: 'Allow collaborator' })).toBeVisible()
  // Approval is an actual authorization boundary: no document or peer channel yet.
  expect(await notes(bob)).toEqual([])
  await expect(bob.getByRole('textbox', { name: 'Markdown content' })).toHaveCount(0)
  expect(await bob.evaluate(() => (window as typeof window & { __testChannels: RTCDataChannel[] }).__testChannels.length)).toBe(0)
  expect(new URL(bob.url()).hash).toBe('')
  await alice.getByRole('button', { name: 'Allow collaborator' }).click()
  await Promise.all([connected(alice), connected(bob)])
  await Promise.all([alice, bob].map(async page => {
    await page.getByRole('button', { name: 'Done', exact: true }).click()
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
    }

    await alice.page.locator('.note-entry.selected').getByRole('button', { name: 'Note actions for E2E shared draft' }).click()
    await alice.page.getByRole('menuitem', { name: 'Move to…' }).click()
    await alice.page.getByRole('textbox', { name: 'Folder path' }).fill('Alice only/Research')
    await alice.page.getByRole('button', { name: 'Move', exact: true }).click()
    await expect.poll(async () => (await notes(alice.page)).find(row => row.note.id === id)?.note.folder).toBe('Alice only/Research')
    expect((await notes(bob.page)).find(row => row.note.id === id)?.note.folder || '').toBe('')
    await expect(bob.page.getByRole('button', { name: 'Open folder Alice only/Research' })).toHaveCount(0)

    await alice.page.getByRole('button', { name: 'Share', exact: true }).click()
    await alice.page.getByRole('button', { name: 'Publish public copy' }).click()
    await expect.poll(async () => (await notes(alice.page)).find(row => row.note.id === id)?.published).not.toBeNull()
    expect((await notes(bob.page)).find(row => row.note.id === id)?.published).toBeNull()
    await alice.page.getByRole('button', { name: 'Unpublish', exact: true }).click()
    await expect.poll(async () => (await notes(alice.page)).find(row => row.note.id === id)?.published).toBeNull()
    await alice.page.getByRole('button', { name: 'Close dialog' }).click()
    await connected(bob.page)

    await bob.page.getByRole('button', { name: 'Disconnect from Pubky' }).click()
    await expect(bob.page.getByRole('button', { name: 'Disconnect from Pubky' })).toHaveCount(0)
    await expect.poll(() => bob.page.evaluate(() => (window as typeof window & { __testChannels: RTCDataChannel[] }).__testChannels.every(channel => channel.readyState === 'closed'))).toBe(true)
    await insert(alice.page, 'end', '\nAfter Bob signed out')
    expect((await notes(bob.page)).find(row => row.note.id === id)?.note.content).toBe(merged)
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

test('real TURN collaboration recovers a lost initial handshake when direct ICE is disabled', async ({ browser, accounts: peers }) => {
    const alice = await peer(browser, true); peers.push(alice)
    const bob = await peer(browser, true); peers.push(bob)
    const id = await share(alice.page, bob.page)
    for (const { page } of peers) {
      expect(await page.evaluate(() => (window as typeof window & { __testDroppedHandshake: number }).__testDroppedHandshake)).toBe(1)
      await expect.poll(() => page.evaluate(async () => {
        const state = window as typeof window & { __testConnections: RTCPeerConnection[] }
        for (const connection of state.__testConnections) {
          if (connection.connectionState !== 'connected') continue
          const stats = await connection.getStats()
          for (const report of stats.values()) {
            if (report.type !== 'candidate-pair' || report.state !== 'succeeded' || !report.nominated) continue
            if (stats.get(report.localCandidateId)?.candidateType === 'relay'
              && stats.get(report.remoteCandidateId)?.candidateType === 'relay') return true
          }
        }
        return false
      }), { message: 'Both selected ICE candidates must be actual TURN relay allocations' }).toBe(true)
    }
    await insert(alice.page, 'end', '\nDelivered through TURN')
    await expect(bob.page.getByRole('textbox', { name: 'Markdown content' })).toHaveValue(`${BODY}\nDelivered through TURN`)
    await Promise.all(peers.map(({ page }) => saved(page, id, `${BODY}\nDelivered through TURN`)))
})
