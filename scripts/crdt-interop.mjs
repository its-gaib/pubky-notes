import assert from 'node:assert/strict'
import { copy, fixture, openWebModules, startCli } from './crdt-interop-support.mjs'

if (process.argv.length !== 2) throw new Error('Usage: node scripts/crdt-interop.mjs')
const web = await openWebModules()
const cli = startCli()
const { initializeNote, ensureCrdt, editNote, mergeNotes, noteRevision } = web.crdt
let passed = 0
const test = async (name, action) => { await action(); passed++; console.log(`PASS ${name}`) }
const same = (a, b) => { assert.deepEqual(a, b); assert.equal(noteRevision(a), noteRevision(b)) }
const exchange = async (a, b) => {
  const left = mergeNotes(copy(a), copy(b))
  const right = await cli.call('crdt:mergeNotes', copy(b), copy(a))
  same(left, right)
  return left
}

try {
  await test('independent legacy initialization produces identical histories', async () => {
    const legacy = { ...fixture('legacy'), title: 'Résumé 🧭', folder: 'Projects/日本語' }
    const fromWeb = await ensureCrdt(copy(legacy))
    const fromCli = await cli.call('crdt:ensureCrdt', copy(legacy))
    same(fromWeb, fromCli)
    same(await exchange(fromWeb, fromCli), fromWeb)
  })

  await test('disjoint web and CLI changes preserve exact text, title, and folder', async () => {
    const base = initializeNote(fixture('disjoint'))
    const browser = editNote(base, { content: `WEB 🧭\n${base.content}`, folder: 'Projects/日本語' })
    const terminal = await cli.call('crdt:editNote', base, { content: `${base.content}\nCLI café`, title: 'Changed in CLI 📝' })
    const merged = await exchange(browser, terminal)
    assert.equal(merged.content, `WEB 🧭\n${base.content}\nCLI café`)
    assert.equal(merged.title, 'Changed in CLI 📝')
    assert.equal(merged.folder, 'Projects/日本語')
  })

  await test('overlapping replacements converge and retain both new contributions', async () => {
    const base = initializeNote({ ...fixture('overlap'), content: 'before 012345 after' })
    const browser = editNote(base, { content: 'before XWEBX after' })
    const terminal = await cli.call('crdt:editNote', base, { content: 'before YCLIY after' })
    const merged = await exchange(browser, terminal)
    assert.ok(['before XWEBXYCLIY after', 'before YCLIYXWEBX after'].includes(merged.content), merged.content)
    same(mergeNotes(merged, browser), merged)
    same(await cli.call('crdt:mergeNotes', terminal, merged), merged)
  })

  await test('duplicate, stale, and out-of-order delivery cannot lose operations', async () => {
    const base = initializeNote(fixture('delivery'))
    const a = editNote(base, { content: `A\n${base.content}` })
    const b = await cli.call('crdt:editNote', base, { content: base.content.replace('Middle', 'Middle B') })
    const c = await cli.call('crdt:editNote', base, { content: `${base.content}\nC` })
    const left = [a, b, base, c, b, a].reduce((state, update) => mergeNotes(state, update), base)
    let right = base
    for (const update of [c, base, a, c, b, base]) right = await cli.call('crdt:mergeNotes', right, update)
    same(left, right)
    assert.equal(left.content, 'A\nFirst\nMiddle B\nLast\nC')
  })

  await test('24 serialized reconnect rounds retain every independent edit', async () => {
    let state = initializeNote(fixture('rounds'))
    let expected = state.content
    for (let round = 0; round < 24; round++) {
      const base = copy(state)
      const browser = editNote(base, { content: `web-${round}\n${base.content}` })
      const terminal = await cli.call('crdt:editNote', base, { content: `${base.content}\ncli-${round}` })
      state = await exchange(browser, terminal)
      state = await exchange(state, base)
      expected = `web-${round}\n${expected}\ncli-${round}`
      assert.equal(state.content, expected)
    }
  })

  await test('Unicode and Markdown survive cross-process edits without broken characters', async () => {
    const base = initializeNote({ ...fixture('unicode'), content: '# Café e\u0301\n日本語 👩🏽‍💻\n- [ ] task' })
    const browser = editNote(base, { content: base.content.replace('Café', '**Café**'), title: '日本語 🧭' })
    const terminal = await cli.call('crdt:editNote', base, { content: `${base.content}\n\n> Ελληνικά 🌍`, folder: '日本語/工作' })
    const merged = await exchange(browser, terminal)
    assert.equal(merged.content, '# **Café** e\u0301\n日本語 👩🏽‍💻\n- [ ] task\n\n> Ελληνικά 🌍')
    assert.equal(merged.title, '日本語 🧭')
    assert.equal(merged.folder, '日本語/工作')
  })

  await test('deletion retains offline text and stale deliveries cannot undo restoration', async () => {
    const base = initializeNote(fixture('trash'))
    const removed = editNote(base, { deleted: true })
    const offline = await cli.call('crdt:editNote', base, { content: `${base.content}\nOffline contribution` })
    const deleted = await exchange(removed, offline)
    assert.equal(deleted.deleted, true)
    assert.equal(deleted.content, `${base.content}\nOffline contribution`)
    const restored = await cli.call('crdt:editNote', deleted, { deleted: false })
    const merged = await exchange(restored, removed)
    assert.equal(merged.deleted, undefined)
    assert.equal(merged.content, deleted.content)
  })

  await test('unrelated new and legacy histories fail explicitly on both sides', async () => {
    for (const [a, b] of [
      [initializeNote(fixture('unrelated')), await cli.call('crdt:initializeNote', fixture('unrelated'))],
      [await ensureCrdt(fixture('changed-legacy')), await cli.call('crdt:ensureCrdt', { ...fixture('changed-legacy'), content: 'Different original' })],
    ]) {
      assert.throws(() => mergeNotes(a, b), { name: 'LineageConflictError' })
      await assert.rejects(cli.call('crdt:mergeNotes', b, a), { name: 'LineageConflictError' })
    }
  })
  await test('shared v2 browser and CLI edits merge into the live document without sharing personal metadata', async () => {
    const { createSharedNote, SharedNoteDocument, joinSharedNote } = web.shared
    const base = createSharedNote(initializeNote(fixture('shared-live')))
    const browser = new SharedNoteDocument(base)
    const peer = new SharedNoteDocument(joinSharedNote(browser.descriptor, browser.getUpdate()))
    try {
      browser.edit({ content: `Browser\n${base.content}`, folder: 'My browser folder' })
      const terminal = await cli.call('crdt:editNote', copy(base), { content: `${base.content}\nCLI`, deleted: true })
      const merged = await exchange(browser.note, terminal)
      browser.mergeLocal(merged)
      assert.equal(browser.note.content, `Browser\n${base.content}\nCLI`)
      assert.equal(browser.note.deleted, true)
      assert.equal(browser.note.folder, 'My browser folder')
      peer.applyPeerUpdate(browser.getUpdate(peer.getStateVector()))
      assert.equal(peer.note.content, browser.note.content)
      assert.equal(peer.note.folder, undefined)
      assert.equal(peer.note.deleted, undefined)
      assert.deepEqual(await cli.call('crdt:validateCrdtNote', copy(browser.note)), browser.note)
    } finally { browser.destroy(); peer.destroy() }
  })

  await test('shared v2 CLI personal-only changes survive reload without changing the peer update', async () => {
    const { createSharedNote, SharedNoteDocument } = web.shared
    const base = createSharedNote(initializeNote(fixture('shared-personal')))
    const moved = await cli.call('crdt:editNote', copy(base), { folder: 'CLI/Private', deleted: true })
    assert.equal(moved.crdt.update, base.crdt.update)
    assert.notEqual(noteRevision(moved), noteRevision(base))
    assert.equal(await cli.call('crdt:noteRevision', moved), noteRevision(moved))
    const browser = new SharedNoteDocument(copy(moved))
    try {
      browser.edit({ content: `${browser.note.content}\nBrowser after reload` })
      const restored = await cli.call('crdt:editNote', copy(browser.note), { deleted: false })
      same(mergeNotes(browser.note, restored), await cli.call('crdt:mergeNotes', restored, browser.note))
      assert.equal(restored.folder, 'CLI/Private')
      assert.equal(restored.deleted, undefined)
      assert.equal(restored.content, `${base.content}\nBrowser after reload`)
    } finally { browser.destroy() }
  })
  console.log(`Current-source web/CLI interoperability: ${passed} scenarios passed.`)
} finally {
  await cli.close()
  await web.close()
}
