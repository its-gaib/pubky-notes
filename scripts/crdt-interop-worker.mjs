// A separate process is deliberate: importing two independent installations of
// Yjs into one runtime can hide interoperability mistakes and triggers warnings.
// This worker never imports the CLI entry point, authentication, or state store.
import { createRequire } from 'node:module'
import * as crdt from '../../pubky-notes-cli/dist/crdt.js'
import * as notes from '../../pubky-notes-cli/dist/notes.js'

const crdtMethods = new Set(['ensureCrdt', 'initializeNote', 'editNote', 'mergeNotes', 'validateCrdtNote', 'noteRevision', 'checkpointNote', 'listNoteVersions', 'readNoteVersion', 'readNoteVersionChanges'])
const noteMethods = new Set(['getNote', 'listNotes', 'createNote', 'updateNote', 'publishNote', 'unpublishNote', 'deleteNote', 'restoreNote'])
let session, signer, client

async function execute(op, args) {
  if (op.startsWith('crdt:') && crdtMethods.has(op.slice(5))) return crdt[op.slice(5)](...args)
  if (op === 'testnet:signin') {
    if (process.argv.length !== 3 || process.argv[2] !== '--local-testnet') throw new Error('Local testnet was not explicitly enabled.')
    if (session) throw new Error('The test worker already has a session.')
    const secret = Uint8Array.from(args[0])
    args[0].fill(0)
    if (secret.length !== 32) throw new Error('Invalid ephemeral test key.')
    const require = createRequire(new URL('../../pubky-notes-cli/package.json', import.meta.url))
    const { Pubky, Keypair } = require('@synonymdev/pubky')
    client = Pubky.testnet('127.0.0.1')
    const keypair = Keypair.fromSecret(secret)
    secret.fill(0)
    try { signer = client.signer(keypair) } finally { keypair.free() }
    session = await signer.signin(`crdt-tests-cli-${crypto.randomUUID()}`)
    return { owner: session.info.publicKey.z32() }
  }
  if (op.startsWith('notes:') && noteMethods.has(op.slice(6))) {
    if (!session) throw new Error('No ephemeral testnet session.')
    return notes[op.slice(6)](session, ...args)
  }
  if (op === 'close') {
    if (session) { await session.signout(); session.free(); session = undefined }
    signer?.free(); client?.free()
    return null
  }
  throw new Error(`Unsupported test operation: ${op}`)
}

let queue = Promise.resolve()
process.on('message', ({ id, op, args }) => {
  queue = queue.then(async () => {
    try { process.send?.({ id, result: await execute(op, args) }) } catch (error) {
      // Never send SDK stacks, session exports, or ephemeral key material.
      process.send?.({ id, error: { name: error.name, code: error.code, message: error.message } })
    }
  })
})
