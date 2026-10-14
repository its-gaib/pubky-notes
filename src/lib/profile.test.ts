import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAvatar, loadProfile, MAX_AVATAR_BYTES, MAX_PROFILE_BYTES } from './profile'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('./pubky', () => ({ getPubky: () => ({ publicStorage: { get: mocks.get } }) }))
const owner = 'y'.repeat(52)
const file = `pubky://${owner}/pub/pubky.app/files/0000000000000`
const blob = `pubky://${owner}/pub/pubky.app/blobs/00000000000000000000000000`
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
beforeEach(() => vi.resetAllMocks())
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('public Pubky profile', () => {
  it('reads the name and resolves a profile file record to its image blob', async () => {
    mocks.get.mockResolvedValueOnce(json({ name: 'Ada Lovelace', image: file }))
      .mockResolvedValueOnce(json({ src: blob, size: png.length, content_type: 'image/png' }))
      .mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'application/octet-stream' } }))
    const profile = await loadProfile(owner)
    expect(profile.name).toBe('Ada Lovelace')
    const avatar = await loadAvatar(profile.image!)
    expect(avatar.type).toBe('image/png')
    expect(new Uint8Array(await avatar.arrayBuffer())).toEqual(png)
    expect(mocks.get.mock.calls.map(([address]) => address)).toEqual([
      `pubky${owner}/pub/pubky.app/profile.json`, file.replace('pubky://', 'pubky'), blob.replace('pubky://', 'pubky'),
    ])
  })

  it('keeps a valid name even when its optional image field is invalid', async () => {
    mocks.get.mockResolvedValue(json({ name: 'Ada Lovelace', image: { invalid: true } }))
    await expect(loadProfile(owner)).resolves.toEqual({ name: 'Ada Lovelace', image: undefined })
  })

  it.each(['', 'ab', '[DELETED]', 'x'.repeat(51)])('rejects invalid/deleted names: %s', async (name) => {
    mocks.get.mockResolvedValue(json({ name }))
    await expect(loadProfile(owner)).rejects.toThrow('Invalid profile name')
  })

  it('bounds streamed profile data even without Content-Length', async () => {
    const cancel = vi.fn()
    mocks.get.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_PROFILE_BYTES + 1)) }, cancel,
    })))
    await expect(loadProfile(owner)).rejects.toThrow('too large')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('handles a missing profile without trying to fetch an avatar', async () => {
    mocks.get.mockResolvedValue(new Response(null, { status: 404 }))
    await expect(loadProfile(owner)).rejects.toThrow('404')
    expect(mocks.get).toHaveBeenCalledOnce()
  })

  it.each([
    `pubky://${owner}/priv/avatar.png`, `pubky://${owner}/pub/../priv/avatar.png`,
    `pubky://${owner}/pub/%2e%2e/avatar.png`, `pubky://${owner}/pub/avatar.png?token=x`,
    `pubky://${owner}/pub/avatar.png#x`, 'https://user:password@example.com/avatar.png',
    'http://example.com/avatar.png', 'data:image/png;base64,aGVsbG8=', 'javascript:alert(1)',
  ])('rejects unsafe image references before reading: %s', async (reference) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(loadAvatar(reference)).rejects.toThrow()
    expect(mocks.get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('revalidates metadata references and refuses another metadata hop', async () => {
    mocks.get.mockResolvedValue(json({ src: file, size: png.length, content_type: 'image/png' }))
    await expect(loadAvatar(file)).rejects.toThrow('Nested')
    expect(mocks.get).toHaveBeenCalledOnce()
    mocks.get.mockResolvedValue(json({ src: `pubky://${owner}/priv/secret`, size: png.length, content_type: 'image/png' }))
    await expect(loadAvatar(file)).rejects.toThrow()
    expect(mocks.get).toHaveBeenCalledTimes(2)
  })

  it('loads HTTPS images without credentials, referrers, or redirects', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(png, { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(loadAvatar('https://example.com/avatar.png')).resolves.toMatchObject({ type: 'image/png' })
    expect(fetch).toHaveBeenCalledWith('https://example.com/avatar.png', expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' }))
  })

  it('rejects oversize media, active image formats and falsely labeled bytes', async () => {
    mocks.get.mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_AVATAR_BYTES + 1) } }))
      .mockResolvedValueOnce(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
      .mockResolvedValueOnce(new Response('<html/>', { headers: { 'content-type': 'image/png' } }))
    await expect(loadAvatar(blob)).rejects.toThrow('too large')
    await expect(loadAvatar(blob)).rejects.toThrow('Unsupported')
    await expect(loadAvatar(blob)).rejects.toThrow('bytes do not match')
  })

  it('times out and cancels a late SDK response', async () => {
    vi.useFakeTimers()
    let resolve!: (value: Response) => void
    mocks.get.mockReturnValue(new Promise<Response>(done => { resolve = done }))
    const result = expect(loadProfile(owner)).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(10_000)
    await result
    const cancel = vi.fn()
    resolve(new Response(new ReadableStream({ cancel })))
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
