import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadFollowRelationship, loadPeerAvatar, loadPeerProfile } from './peer-profile'
import { MAX_AVATAR_BYTES, MAX_PROFILE_BYTES } from './profile'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('./pubky', () => ({ getPubky: () => ({ publicStorage: { get: mocks.get } }) }))
const viewer = 'y'.repeat(52), peer = 'b'.repeat(52)
const file = `pubky://${peer}/pub/pubky.app/files/avatar`
const blob = `pubky://${peer}/pub/pubky.app/blobs/avatar`
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
beforeEach(() => vi.resetAllMocks())
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('independently loaded peer profiles', () => {
  it('reads the verified owner profile and sanitizes its display name', async () => {
    mocks.get.mockResolvedValue(json({ name: '  A\nB\u202e C  ', image: file }))
    await expect(loadPeerProfile(peer)).resolves.toEqual({ name: 'AB C', image: file })
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(`pubky${peer}/pub/pubky.app/profile.json`)
  })

  it.each(['https://tracking.example/avatar.png', `pubky://${viewer}/pub/avatar.png`])('omits an image outside the verified owner: %s', async image => {
    mocks.get.mockResolvedValue(json({ name: 'Peer name', image }))
    await expect(loadPeerProfile(peer)).resolves.toEqual({ name: 'Peer name', image: undefined })
    expect(mocks.get).toHaveBeenCalledOnce()
  })

  it('loads owner-local file metadata and returns verified image bytes', async () => {
    mocks.get.mockResolvedValueOnce(json({ src: blob, size: png.length, content_type: 'image/png' }))
      .mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'application/octet-stream' } }))
    const avatar = await loadPeerAvatar(peer, file)
    expect(avatar.type).toBe('image/png')
    expect(new Uint8Array(await avatar.arrayBuffer())).toEqual(png)
    expect(mocks.get.mock.calls.map(([address]) => address)).toEqual([file.replace('pubky://', 'pubky'), blob.replace('pubky://', 'pubky')])
  })

  it.each(['https://tracking.example/avatar.png', `pubky://${viewer}/pub/avatar.png`, `pubky://${peer}/pub/../priv/avatar.png`])('rejects initial unsafe image references without any network request: %s', async reference => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(loadPeerAvatar(peer, reference)).rejects.toThrow()
    expect(mocks.get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['https://tracking.example/avatar.png', `pubky://${viewer}/pub/avatar.png`])('rejects unsafe nested image references before fetching: %s', async src => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    mocks.get.mockResolvedValue(json({ src, size: png.length, content_type: 'image/png' }))
    await expect(loadPeerAvatar(peer, file)).rejects.toThrow()
    expect(mocks.get).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves byte and MIME limits for peer images', async () => {
    mocks.get.mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_AVATAR_BYTES + 1) } }))
      .mockResolvedValueOnce(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
      .mockResolvedValueOnce(new Response('<html/>', { headers: { 'content-type': 'image/png' } }))
    await expect(loadPeerAvatar(peer, blob)).rejects.toThrow('too large')
    await expect(loadPeerAvatar(peer, blob)).rejects.toThrow('Unsupported')
    await expect(loadPeerAvatar(peer, blob)).rejects.toThrow('bytes do not match')
  })
})

describe('public Pubky follows', () => {
  it('checks the logged-in viewer own canonical follow record for the verified peer', async () => {
    mocks.get.mockResolvedValue(json({ created_at: 1_792_073_330_000_000 }))
    await expect(loadFollowRelationship(viewer, peer)).resolves.toEqual({ state: 'following' })
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(`pubky${viewer}/pub/pubky.app/follows/${peer}`)
  })

  it.each([404, 410])('treats explicit HTTP %i as not-following', async status => {
    mocks.get.mockResolvedValue(new Response(null, { status }))
    await expect(loadFollowRelationship(viewer, peer)).resolves.toEqual({ state: 'not-following' })
  })

  it.each([404, 410])('recognizes SDK RequestError status %i as not-following', async statusCode => {
    mocks.get.mockRejectedValue({ name: 'RequestError', data: { statusCode } })
    await expect(loadFollowRelationship(viewer, peer)).resolves.toEqual({ state: 'not-following' })
  })

  it.each([401, 403, 429, 500])('keeps HTTP %i failures unknown instead of claiming not-following', async status => {
    mocks.get.mockResolvedValue(new Response(null, { status }))
    await expect(loadFollowRelationship(viewer, peer)).resolves.toMatchObject({ state: 'unknown' })
  })

  it('keeps network, authentication, malformed JSON, invalid shape and oversized response failures unknown', async () => {
    for (const error of [new Error('Network failed'), { name: 'AuthenticationError', data: { statusCode: 404 } }]) {
      mocks.get.mockRejectedValueOnce(error)
      await expect(loadFollowRelationship(viewer, peer)).resolves.toMatchObject({ state: 'unknown' })
    }
    for (const response of [new Response('{'), json({ created_at: 'today' }), json({}), json([]), json({ created_at: 1.5 }),
      new Response('x'.repeat(MAX_PROFILE_BYTES + 1))]) {
      mocks.get.mockResolvedValueOnce(response)
      await expect(loadFollowRelationship(viewer, peer)).resolves.toMatchObject({ state: 'unknown' })
    }
  })

  it('validates both Pubky IDs before reading anything', async () => {
    await expect(loadFollowRelationship('../private', peer)).resolves.toMatchObject({ state: 'unknown' })
    await expect(loadFollowRelationship(viewer, `${peer}/other`)).resolves.toMatchObject({ state: 'unknown' })
    await expect(loadPeerAvatar('../private', blob)).rejects.toThrow('Invalid Pubky')
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('returns unknown on timeout and cancels a late SDK response', async () => {
    vi.useFakeTimers()
    let resolve!: (response: Response) => void
    mocks.get.mockReturnValue(new Promise<Response>(done => { resolve = done }))
    const pending = loadFollowRelationship(viewer, peer)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toMatchObject({ state: 'unknown' })
    const cancel = vi.fn()
    resolve(new Response(new ReadableStream({ cancel })))
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not turn an aborted missing response into a not-following result', async () => {
    const controller = new AbortController()
    mocks.get.mockImplementation(() => { controller.abort(); return Promise.resolve(new Response(null, { status: 404 })) })
    await expect(loadFollowRelationship(viewer, peer, controller.signal)).resolves.toMatchObject({ state: 'unknown' })
  })
})
