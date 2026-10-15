// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PeerIdentity from './PeerIdentity'

const mocks = vi.hoisted(() => ({ profile: vi.fn(), avatar: vi.fn(), follow: vi.fn() }))
vi.mock('../lib/peer-profile', () => ({ loadPeerProfile: mocks.profile, loadPeerAvatar: mocks.avatar, loadFollowRelationship: mocks.follow }))
const owner = 'y'.repeat(52), ownOwner = 'b'.repeat(52), copy = vi.fn()
const props = { owner, ownOwner, copy }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.profile.mockResolvedValue({ name: 'Ada Lovelace' })
  mocks.follow.mockResolvedValue({ state: 'following' })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn().mockReturnValue('blob:verified-avatar') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})
afterEach(cleanup)

it('looks up the verified account independently and displays a copyable full ID with profile and follow state', async () => {
  mocks.profile.mockResolvedValue({ name: 'Ada Lovelace', image: `pubky${owner}/pub/avatar.png` })
  mocks.avatar.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
  const view = render(<PeerIdentity {...props} />)
  expect(screen.getByText(`pubky${owner}`)).toBeTruthy()
  expect(screen.getByText('Verified Pubky account')).toBeTruthy()
  await screen.findByText('Ada Lovelace')
  await screen.findByText('You follow this person.')
  expect(mocks.profile).toHaveBeenCalledWith(owner, expect.any(AbortSignal))
  expect(mocks.avatar).toHaveBeenCalledWith(owner, `pubky${owner}/pub/avatar.png`, expect.any(AbortSignal))
  expect(mocks.follow).toHaveBeenCalledWith(ownOwner, owner, expect.any(AbortSignal))
  await waitFor(() => expect(view.container.querySelector('img')?.src).toBe('blob:verified-avatar'))
  fireEvent.click(screen.getByRole('button', { name: 'Copy verified Pubky identifier' }))
  expect(copy).toHaveBeenCalledExactlyOnceWith(`pubky${owner}`)
  view.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:verified-avatar')
})

it('renders profile text safely and warns when the signed-in account does not follow the verified account', async () => {
  const label = '<img src=x onerror=alert(1)>'
  mocks.profile.mockResolvedValue({ name: label })
  mocks.follow.mockResolvedValue({ state: 'not-following' })
  const view = render(<PeerIdentity {...props} />)
  await screen.findByText(label)
  await screen.findByText('You don’t follow this person.')
  expect(view.container.querySelector('img')).toBeNull()
  expect(screen.queryByText('You follow this person.')).toBeNull()
})

it('keeps the verified identifier and distinguishes unavailable profiles and failed follow lookup', async () => {
  mocks.profile.mockRejectedValue(new Error('Private transport details'))
  mocks.follow.mockRejectedValue(new Error('Private transport details'))
  render(<PeerIdentity {...props} />)
  await screen.findByText('Public profile unavailable. Use the Pubky identifier to recognize this person.')
  await screen.findByText('Could not check whether you follow this person.')
  expect(screen.getByText(`pubky${owner}`)).toBeTruthy()
  expect(screen.queryByText('You don’t follow this person.')).toBeNull()
  expect(screen.queryByText(/Private transport details/)).toBeNull()
})

it('does not fetch or label a malformed account as verified', () => {
  render(<PeerIdentity {...props} owner="https://untrusted.example/profile" />)
  expect(screen.getByText('This person’s Pubky identity could not be verified.')).toBeTruthy()
  expect(screen.queryByText('Verified Pubky account')).toBeNull()
  expect(mocks.profile).not.toHaveBeenCalled()
  expect(mocks.follow).not.toHaveBeenCalled()
})

it('clears the previous person immediately and ignores a late profile or follow result', async () => {
  let profile!: (value: { name: string; image: string }) => void
  let follow!: (value: { state: string }) => void
  mocks.profile.mockReturnValueOnce(new Promise(done => { profile = done })).mockResolvedValueOnce({ name: 'Grace Hopper' })
  mocks.follow.mockReturnValueOnce(new Promise(done => { follow = done })).mockResolvedValueOnce({ state: 'not-following' })
  const view = render(<PeerIdentity {...props} />)
  const nextOwner = 'n'.repeat(52)
  view.rerender(<PeerIdentity {...props} owner={nextOwner} />)
  expect(screen.queryByText(`pubky${owner}`)).toBeNull()
  await screen.findByText('Grace Hopper')
  await act(async () => { profile({ name: 'Old person', image: 'old-reference' }); follow({ state: 'following' }) })
  expect(screen.queryByText('Old person')).toBeNull()
  expect(screen.queryByText('You follow this person.')).toBeNull()
  expect(screen.getByText('You don’t follow this person.')).toBeTruthy()
  expect(mocks.avatar).not.toHaveBeenCalled()
  expect(mocks.profile.mock.calls[0][1].aborted).toBe(true)
  expect(mocks.follow.mock.calls[0][2].aborted).toBe(true)
})

it('does not reuse the previous viewer’s follow relationship and ignores a late photo', async () => {
  let avatar!: (blob: Blob) => void
  mocks.profile.mockResolvedValueOnce({ name: 'Ada Lovelace', image: 'avatar' }).mockResolvedValueOnce({ name: 'Ada Lovelace' })
  mocks.avatar.mockReturnValue(new Promise(done => { avatar = done }))
  const view = render(<PeerIdentity {...props} />)
  await screen.findByText('You follow this person.')
  await waitFor(() => expect(mocks.avatar).toHaveBeenCalledOnce())
  mocks.follow.mockResolvedValue({ state: 'unknown', error: 'Cannot fetch' })
  view.rerender(<PeerIdentity {...props} ownOwner={'n'.repeat(52)} />)
  expect(screen.queryByText('You follow this person.')).toBeNull()
  await screen.findByText('Could not check whether you follow this person.')
  await act(async () => { avatar(new Blob(['old-photo'])) })
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it('uses initials when a validated photo cannot be decoded', async () => {
  mocks.profile.mockResolvedValue({ name: 'Ada Lovelace', image: 'avatar' })
  mocks.avatar.mockResolvedValue(new Blob(['image']))
  const view = render(<PeerIdentity {...props} />)
  await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull())
  fireEvent.error(view.container.querySelector('img')!)
  expect(screen.getByText('AL')).toBeTruthy()
  expect(screen.getByText('Ada Lovelace')).toBeTruthy()
})
