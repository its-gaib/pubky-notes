import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { Pubky, Keypair, PublicKey } from '@synonymdev/pubky'
import { fixture, openWebModules, startCli } from './crdt-interop-support.mjs'

// This command intentionally cannot accept a host, account, or session override.
// It never calls the application's getPubky() or the CLI's login/state APIs.
if (process.argv.length !== 3 || process.argv[2] !== '--local-testnet') {
  throw new Error('Explicit opt-in required: node scripts/crdt-homeserver.mjs --local-testnet')
}
const HOMESERVER = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'
for (const port of [6286, 6287, 15411, 15412]) {
  await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const fail = () => { socket.destroy(); reject(new Error(`Local Pubky testnet unavailable at 127.0.0.1:${port}; no tests were skipped.`)) }
    socket.setTimeout(3_000, fail)
    socket.once('error', fail)
    socket.once('connect', () => { socket.destroy(); resolve() })
  })
}

const web = await openWebModules()
const cli = startCli({ localTestnet: true })
const { initializeNote, editNote, noteRevision } = web.crdt
const { saveNote, publishNote, listNotes } = web.notes
const keypair = Keypair.random()
const resources = [], sessions = [], paths = new Set()
let primarySession, failure, passed = 0
const test = async (name, action) => { await action(); passed++; console.log(`PASS ${name}`) }
const privatePath = id => `/priv/notes/${id}.json`
const publicPath = id => `/pub/notes/${id}.json`
const register = id => { paths.add(privatePath(id)); paths.add(publicPath(id)); return id }
const missing = error => [404, 410].includes(error?.data?.statusCode)
const sameHistory = (a, b) => { assert.deepEqual(a, b); assert.equal(noteRevision(a), noteRevision(b)) }
async function freshSession(label) {
  const client = Pubky.testnet('127.0.0.1')
  const signer = client.signer(keypair)
  resources.push(client, signer)
  const session = await signer.signin(`crdt-tests-${label}-${randomUUID()}`)
  sessions.push(session)
  return { client, session }
}

try {
  const client = Pubky.testnet('127.0.0.1')
  const signer = client.signer(keypair)
  resources.push(client, signer)
  const homeserver = PublicKey.from(HOMESERVER)
  try { await signer.signup(homeserver) } finally { homeserver.free() }
  primarySession = await signer.signin(`crdt-tests-web-${randomUUID()}`)
  sessions.push(primarySession)
  const secret = keypair.secret()
  const transferable = Array.from(secret)
  secret.fill(0)
  try {
    const connected = await cli.call('testnet:signin', transferable)
    assert.equal(connected.owner, primarySession.info.publicKey.z32())
  } finally { transferable.fill(0) }
  const { session: independentSession } = await freshSession('second-web')
  const id = register(randomUUID())
  let current = initializeNote({ ...fixture(id), folder: 'Private/Only', content: 'First\nMiddle\nLast' })
  let staleCliView

  await test('real private writes are discoverable and readable in another SDK session', async () => {
    current = await saveNote(primarySession, current)
    const actual = await (await independentSession.storage.get(privatePath(id))).json()
    sameHistory(current, actual)
    const listed = await listNotes(independentSession)
    assert.deepEqual(listed.map(record => record.note.id), [id])
    staleCliView = await cli.call('notes:getNote', id)
    sameHistory(current, staleCliView.note)
  })

  await test('CLI writes and a stale browser edit merge instead of overwriting', async () => {
    const staleBrowser = editNote(current, { content: `WEB 🧭\n${current.content}` })
    await cli.call('notes:updateNote', id, staleCliView.revision, { content: `${current.content}\nCLI café`, title: 'CLI title 📝' })
    current = await saveNote(primarySession, staleBrowser)
    assert.equal(current.content, 'WEB 🧭\nFirst\nMiddle\nLast\nCLI café')
    assert.equal(current.title, 'CLI title 📝')
    sameHistory(current, (await cli.call('notes:getNote', id)).note)
  })

  await test('stale CLI revisions reject without writing, then a fresh retry succeeds', async () => {
    await assert.rejects(cli.call('notes:updateNote', id, staleCliView.revision, { content: 'MUST NOT REPLACE THE NOTE' }), { code: 'REVISION_CONFLICT' })
    sameHistory(current, await (await independentSession.storage.get(privatePath(id))).json())
    const fresh = await cli.call('notes:getNote', id)
    const updated = await cli.call('notes:updateNote', id, fresh.revision, { content: `${fresh.note.content}\nCLI retry` })
    assert.equal(updated.note.content, `${current.content}\nCLI retry`)
    current = updated.note
  })

  await test('a real competing storage lock rejects both writers and permits retry after release', async () => {
    const before = await cli.call('notes:getNote', id)
    const lock = await primarySession.storage.lock(privatePath(id), 60)
    const browserEdit = editNote(current, { content: `${current.content}\nWeb lock retry` })
    try {
      await assert.rejects(cli.call('notes:updateNote', id, before.revision, { title: 'Blocked CLI title' }), { code: 'REVISION_CONFLICT' })
      await assert.rejects(saveNote(independentSession, browserEdit), /being changed|lock expired/)
      sameHistory(current, await (await independentSession.storage.get(privatePath(id))).json())
    } finally {
      try { await primarySession.storage.unlock(lock) } finally { lock.free() }
    }
    current = await saveNote(independentSession, browserEdit)
    const fresh = await cli.call('notes:getNote', id)
    const retry = await cli.call('notes:updateNote', id, fresh.revision, { title: 'CLI after lock release' })
    assert.equal(retry.note.title, 'CLI after lock release')
    assert.equal(retry.note.content, browserEdit.content)
    current = retry.note
  })

  await test('publishing exposes only the five reviewed fields, never unseen private edits or history', async () => {
    const reviewed = current
    const latest = await cli.call('notes:getNote', id)
    await cli.call('notes:updateNote', id, latest.revision, {
      content: `${latest.note.content}\nUNSEEN PRIVATE TEXT`, folder: 'Secret/Folder',
    })
    const published = await publishNote(primarySession, reviewed)
    const { client: anonymousClient, session: reader } = await freshSession('publication-readback')
    const address = `pubky${reader.info.publicKey.z32()}${publicPath(id)}`
    const publicJson = await (await anonymousClient.publicStorage.get(address)).json()
    assert.deepEqual(Object.keys(publicJson).sort(), ['content', 'createdAt', 'id', 'title', 'updatedAt'])
    assert.deepEqual(publicJson, published)
    assert.equal(publicJson.content, reviewed.content)
    assert.ok(!JSON.stringify(publicJson).includes('UNSEEN PRIVATE TEXT'))
    assert.ok(!JSON.stringify(publicJson).includes('Secret/Folder'))
    current = await (await reader.storage.get(privatePath(id))).json()
    assert.equal(current.content, `${reviewed.content}\nUNSEEN PRIVATE TEXT`)
    assert.equal(current.folder, 'Secret/Folder')
    assert.ok(current.crdt.update)
  })

  await test('deletion, offline edits, and explicit restore preserve content without republishing', async () => {
    const beforeDelete = await cli.call('notes:getNote', id)
    const offline = editNote(beforeDelete.note, { content: `${beforeDelete.note.content}\nOFFLINE CONTRIBUTION` })
    await cli.call('notes:deleteNote', id, beforeDelete.revision)
    assert.equal(await independentSession.storage.exists(publicPath(id)), false)
    const tombstone = await saveNote(primarySession, offline)
    assert.equal(tombstone.deleted, true)
    assert.equal(tombstone.content, `${beforeDelete.note.content}\nOFFLINE CONTRIBUTION`)
    assert.deepEqual(await cli.call('notes:listNotes'), [])
    const trash = await cli.call('notes:listNotes', { trash: true })
    assert.deepEqual(trash.map(view => view.note.id), [id])
    const restored = await cli.call('notes:restoreNote', id, trash[0].revision)
    current = await saveNote(primarySession, tombstone)
    sameHistory(current, restored.note)
    assert.equal(current.deleted, undefined)
    assert.equal(current.content, tombstone.content)
    assert.equal(await independentSession.storage.exists(publicPath(id)), false)
    assert.deepEqual((await cli.call('notes:listNotes')).map(view => view.note.id), [id])
    assert.deepEqual(await cli.call('notes:listNotes', { trash: true }), [])
  })

  await test('a note created by CLI can be edited by web and read back by a fresh session', async () => {
    const created = await cli.call('notes:createNote', { title: 'CLI origin', content: '# 日本語\n👩🏽‍💻', folder: 'CLI/Origin' })
    register(created.note.id)
    const edited = editNote(created.note, { content: `${created.note.content}\nWeb contribution` })
    const saved = await saveNote(primarySession, edited)
    assert.equal(saved.content, '# 日本語\n👩🏽‍💻\nWeb contribution')
    sameHistory(saved, (await cli.call('notes:getNote', created.note.id)).note)
    const { session: reader } = await freshSession('final-readback')
    sameHistory(saved, await (await reader.storage.get(privatePath(created.note.id))).json())
    sameHistory(current, await (await reader.storage.get(privatePath(id))).json())
  })

  await test('unrelated history is rejected without overwriting the actual homeserver file', async () => {
    const { crdt: _history, ...fields } = current
    const unrelated = initializeNote({ ...fields, content: 'UNRELATED REPLACEMENT' })
    await assert.rejects(saveNote(primarySession, unrelated), { name: 'LineageConflictError' })
    sameHistory(current, await (await independentSession.storage.get(privatePath(id))).json())
  })
} catch (error) { failure = error } finally {
  const cleanupErrors = []
  if (primarySession) {
    for (const path of paths) {
      try { await primarySession.storage.delete(path) } catch (error) {
        if (!missing(error)) cleanupErrors.push(new Error(`Could not remove generated test file ${path}.`))
      }
    }
    for (const path of paths) {
      try { assert.equal(await primarySession.storage.exists(path), false) } catch {
        cleanupErrors.push(new Error(`Generated test file cleanup was not confirmed for ${path}.`))
      }
    }
  }
  try { await cli.close() } catch { cleanupErrors.push(new Error('Could not close ephemeral CLI test session.')) }
  for (const session of sessions.reverse()) {
    try { await session.signout() } catch { cleanupErrors.push(new Error('Could not sign out an ephemeral web test session.')) }
    session.free()
  }
  for (const resource of resources.reverse()) resource.free()
  keypair.free()
  await web.close()
  if (cleanupErrors.length) failure = new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'Integration test or cleanup failed.')
}
if (failure) throw failure
console.log(`Real local Pubky homeserver: ${passed} scenarios passed; generated files removed and sessions signed out.`)
