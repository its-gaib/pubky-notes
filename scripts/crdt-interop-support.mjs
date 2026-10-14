import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

export const root = fileURLToPath(new URL('../', import.meta.url))

// Load the application's current TypeScript, without its development server,
// .env files, or transport factory. Each side has its own copy of Yjs.
export async function openWebModules() {
  const server = await createServer({
    root, configFile: false, envFile: false, logLevel: 'error', appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  try {
    const crdt = await server.ssrLoadModule('/src/lib/crdt.ts')
    const notes = await server.ssrLoadModule('/src/lib/notes.ts')
    const shared = await server.ssrLoadModule('/src/lib/shared-note.ts')
    return { crdt, notes, shared, close: () => server.close() }
  } catch (error) {
    await server.close()
    throw error
  }
}

export function startCli({ localTestnet = false } = {}) {
  const child = fork(new URL('./crdt-interop-worker.mjs', import.meta.url), localTestnet ? ['--local-testnet'] : [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  let nextId = 0
  const pending = new Map()
  child.on('message', ({ id, result, error }) => {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    clearTimeout(request.timer)
    if (error) request.reject(Object.assign(new Error(error.message), { name: error.name, code: error.code }))
    else request.resolve(result)
  })
  const fail = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
    pending.clear()
  }
  child.on('error', fail)
  child.on('exit', (code, signal) => fail(new Error(`CLI test worker exited (${signal ?? code}). Build ../pubky-notes-cli first.`)))
  function call(op, ...args) {
    return new Promise((resolve, reject) => {
      if (!child.connected) { reject(new Error('CLI test worker is not connected.')); return }
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CLI test worker timed out during ${op}.`))
        child.kill()
      }, 30_000)
      pending.set(id, { resolve, reject, timer })
      child.send({ id, op, args }, error => { if (error) fail(error) })
    })
  }
  return {
    call,
    async close() {
      try { if (child.connected) await call('close') } finally {
        if (child.connected) child.disconnect()
        child.kill()
      }
    },
  }
}

export const copy = value => JSON.parse(JSON.stringify(value))
export function fixture(id = 'interop') {
  return { id, title: 'Interop note', content: 'First\nMiddle\nLast',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
}
