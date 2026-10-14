// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AccountProfile from './AccountProfile'

const mocks = vi.hoisted(() => ({ profile: vi.fn(), avatar: vi.fn() }))
vi.mock('../lib/profile', () => ({ loadProfile: mocks.profile, loadAvatar: mocks.avatar }))
const owner = 'y'.repeat(52)
const copy = vi.fn().mockResolvedValue(undefined)
const disconnect = vi.fn()
const props = { owner, copy, disconnect, disabled: false }
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn().mockReturnValue('blob:avatar') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})
afterEach(cleanup)

it('shows the profile name and photo, copies the complete identifier, and releases the image', async () => {
  mocks.profile.mockResolvedValue({ name: 'Ada Lovelace', image: 'avatar-reference' })
  mocks.avatar.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
  const view = render(<AccountProfile {...props} />)
  await screen.findByText('Ada Lovelace')
  await waitFor(() => expect(view.container.querySelector('img')?.src).toBe('blob:avatar'))
  fireEvent.click(screen.getByRole('button', { name: 'Copy Pubky identifier' }))
  expect(copy).toHaveBeenCalledExactlyOnceWith(`pubky${owner}`)
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect from Pubky' }))
  expect(disconnect).toHaveBeenCalledOnce()
  view.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:avatar')
})

it('keeps the name and identifier when the photo cannot be fetched', async () => {
  mocks.profile.mockResolvedValue({ name: 'Ada Lovelace', image: 'broken-avatar' })
  mocks.avatar.mockRejectedValue(new Error('Not found'))
  const view = render(<AccountProfile {...props} />)
  await screen.findByText('Ada Lovelace')
  expect(screen.getByText('AL')).toBeTruthy()
  expect(view.container.querySelector('img')).toBeNull()
  expect(screen.getByRole('button', { name: 'Copy Pubky identifier' })).toBeTruthy()
})

it('falls back to the identifier when there is no profile', async () => {
  mocks.profile.mockRejectedValue(new Error('No profile'))
  render(<AccountProfile {...props} />)
  await waitFor(() => expect(mocks.profile).toHaveBeenCalledOnce())
  expect(screen.getByText('Pubky account')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Copy Pubky identifier' }))
  expect(copy).toHaveBeenCalledWith(`pubky${owner}`)
})

it('clears the old identity immediately and ignores its late image after switching accounts', async () => {
  let resolve!: (blob: Blob) => void
  mocks.profile.mockResolvedValueOnce({ name: 'Ada Lovelace', image: 'slow-avatar' }).mockResolvedValueOnce({ name: 'Grace Hopper' })
  mocks.avatar.mockReturnValue(new Promise<Blob>(done => { resolve = done }))
  const view = render(<AccountProfile {...props} />)
  await screen.findByText('Ada Lovelace')
  view.rerender(<AccountProfile {...props} owner={'b'.repeat(52)} />)
  expect(screen.queryByText('Ada Lovelace')).toBeNull()
  await screen.findByText('Grace Hopper')
  await act(async () => { resolve(new Blob(['old-image'])) })
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(mocks.profile.mock.calls[0][1].aborted).toBe(true)
})

it('falls back to initials if the browser cannot decode the photo', async () => {
  mocks.profile.mockResolvedValue({ name: 'Ada Lovelace', image: 'avatar-reference' })
  mocks.avatar.mockResolvedValue(new Blob(['image']))
  const view = render(<AccountProfile {...props} />)
  await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull())
  fireEvent.error(view.container.querySelector('img')!)
  expect(screen.getByText('AL')).toBeTruthy()
  expect(screen.getByText('Ada Lovelace')).toBeTruthy()
})
