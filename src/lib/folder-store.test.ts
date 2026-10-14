import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@synonymdev/pubky'
import {
  FOLDERS_PATH, loadFolders, MAX_FOLDER_STORE_BYTES, MAX_FOLDERS, normalizeFolderPaths, saveFolders,
} from './folder-store'

function makeSession(value: unknown = { version: 1, folders: [] }) {
  let stored = value
  const storage = {
    get: vi.fn(async () => new Response(JSON.stringify(stored))),
    putJson: vi.fn(async (_path: string, updated: unknown) => { stored = updated }),
  }
  return { session: { storage } as unknown as Session, storage }
}

describe('private folder metadata', () => {
  it('roundtrips empty folders and nested paths without creating note files', async () => {
    const { session, storage } = makeSession()
    await expect(saveFolders(session, [' Work / Ideas ', 'Empty', 'Work/Ideas'])).resolves.toEqual(['Empty', 'Work/Ideas'])
    expect(FOLDERS_PATH).toBe('/priv/notes/folders')
    expect(storage.putJson).toHaveBeenCalledExactlyOnceWith('/priv/notes/folders', {
      version: 1, folders: ['Empty', 'Work/Ideas'],
    })
    await expect(loadFolders(session)).resolves.toEqual(['Empty', 'Work/Ideas'])
    expect(storage.get).toHaveBeenCalledExactlyOnceWith('/priv/notes/folders')
    await expect(saveFolders(session, [])).resolves.toEqual([])
    await expect(loadFolders(session)).resolves.toEqual([])
  })

  it('normalizes and deduplicates names read from another client', async () => {
    const { session } = makeSession({ version: 1, folders: [' Z ', 'A/日本語', '/Z/'] })
    await expect(loadFolders(session)).resolves.toEqual(['A/日本語', 'Z'])
  })

  it.each([404, 410])('treats an SDK missing response (%i) as an empty registry', async (statusCode) => {
    const { session, storage } = makeSession()
    storage.get.mockRejectedValueOnce({ data: { statusCode } })
    await expect(loadFolders(session)).resolves.toEqual([])
    expect(storage.putJson).not.toHaveBeenCalled()
  })

  it.each([404, 410])('treats an HTTP missing response (%i) as an empty registry', async (status) => {
    const { session, storage } = makeSession()
    storage.get.mockResolvedValueOnce(new Response('Missing', { status }))
    await expect(loadFolders(session)).resolves.toEqual([])
  })

  it('preserves permission, network, and write failures', async () => {
    const { session, storage } = makeSession()
    const permissionError = { data: { statusCode: 403 } }
    storage.get.mockRejectedValueOnce(permissionError)
    await expect(loadFolders(session)).rejects.toEqual(permissionError)
    storage.get.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
    await expect(loadFolders(session)).rejects.toThrow('HTTP 503')
    storage.get.mockRejectedValueOnce(new Error('Offline'))
    await expect(loadFolders(session)).rejects.toThrow('Offline')
    storage.putJson.mockRejectedValueOnce(new Error('Write rejected'))
    await expect(saveFolders(session, ['Work'])).rejects.toThrow('Write rejected')
  })

  it.each([
    null, [], { folders: [] }, { version: 2, folders: [] }, { version: 1 },
    { version: 1, folders: 'Work' }, { version: 1, folders: [false] },
    { version: 1, folders: [''] }, { version: 1, folders: [' / '] },
    { version: 1, folders: ['Work/../Private'] }, { version: 1, folders: ['Work\nPrivate'] },
    { version: 1, folders: [Array(9).fill('x').join('/')] },
  ])('rejects malformed or unsafe metadata %j', async (value) => {
    const { session, storage } = makeSession(value)
    await expect(loadFolders(session)).rejects.toThrow()
    expect(storage.putJson).not.toHaveBeenCalled()
  })

  it('rejects invalid save input before writing', async () => {
    const { session, storage } = makeSession()
    await expect(saveFolders(session, ['Work', 'Work/../Private'])).rejects.toThrow()
    await expect(saveFolders(session, [''])).rejects.toThrow()
    expect(storage.putJson).not.toHaveBeenCalled()
  })

  it('bounds the number of entries during load, save, and operation preflight', async () => {
    const folders = Array.from({ length: MAX_FOLDERS + 1 }, (_, index) => `Folder ${index}`)
    const { session, storage } = makeSession({ version: 1, folders })
    await expect(loadFolders(session)).rejects.toThrow('at most')
    await expect(saveFolders(session, folders)).rejects.toThrow('at most')
    expect(() => normalizeFolderPaths(folders)).toThrow('at most')
    expect(storage.putJson).not.toHaveBeenCalled()
  })

  it('bounds the encoded size before saving or beginning a multi-file operation', async () => {
    const folders = Array.from({ length: 1_000 }, (_, index) => `${'日'.repeat(80)}/${'本'.repeat(80)}/${index}`)
    const { session, storage } = makeSession()
    await expect(saveFolders(session, folders)).rejects.toThrow('too large')
    expect(() => normalizeFolderPaths(folders)).toThrow('too large')
    expect(storage.putJson).not.toHaveBeenCalled()
  })

  it('cancels a response with an oversized advertised length before reading it', async () => {
    const { session, storage } = makeSession()
    const response = new Response('{}', { headers: { 'content-length': String(MAX_FOLDER_STORE_BYTES + 1) } })
    const cancel = vi.spyOn(response.body!, 'cancel')
    storage.get.mockResolvedValueOnce(response)
    await expect(loadFolders(session)).rejects.toThrow('too large')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('bounds streamed bytes even when the content-length header is missing or inaccurate', async () => {
    const { session, storage } = makeSession()
    for (const headers of [new Headers(), new Headers({ 'content-length': '2' })]) {
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(MAX_FOLDER_STORE_BYTES + 1)) },
        cancel,
      })
      storage.get.mockResolvedValueOnce(new Response(body, { headers }))
      await expect(loadFolders(session)).rejects.toThrow('too large')
      expect(cancel).toHaveBeenCalledOnce()
    }
  })

  it('rejects invalid JSON, invalid UTF-8, and an empty response', async () => {
    const { session, storage } = makeSession()
    for (const response of [new Response('not json'), new Response(new Uint8Array([0xff])), new Response(null)]) {
      storage.get.mockResolvedValueOnce(response)
      await expect(loadFolders(session)).rejects.toThrow()
    }
  })
})
