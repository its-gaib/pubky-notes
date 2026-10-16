// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationView } from '../hooks/useCollaboration'
import CollaborationBar from './CollaborationBar'

const mocks = vi.hoisted(() => ({ profile: vi.fn(), avatar: vi.fn(), follow: vi.fn() }))
vi.mock('../lib/peer-profile', () => ({ loadPeerProfile: mocks.profile, loadPeerAvatar: mocks.avatar, loadFollowRelationship: mocks.follow }))
const peerOwner = 'y'.repeat(52), ownOwner = 'b'.repeat(52)
const connected: CollaborationView = {
  noteId: 'shared', role: 'host', peerReceived: true, working: false,
  status: { state: 'connected', relayAvailable: true, peers: [{ key: 'peer', session: 'session', owner: peerOwner, presenceSupported: true }], participantCount: 2, maxParticipants: 10, creatorOnline: true },
}
function props() {
  return { view: connected, ownOwner, sharedTitle: 'Shared research', openNote: vi.fn(), disconnect: vi.fn(), copy: vi.fn() }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.profile.mockResolvedValue({ name: 'Known collaborator' })
  mocks.follow.mockResolvedValue({ state: 'not-following' })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn().mockReturnValue('blob:collaborator-avatar') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})
afterEach(cleanup)

describe('persistent collaboration bar', () => {
  it('shows the independently resolved identity and warning without the controls panel or stealing editor focus', async () => {
    mocks.profile.mockResolvedValue({ name: 'Known collaborator', image: `pubky${peerOwner}/pub/avatar.png` })
    mocks.avatar.mockResolvedValue(new Blob(['avatar'], { type: 'image/png' }))
    const actions = props()
    const renderBar = (view: CollaborationView) => <><textarea aria-label="Editor" /><CollaborationBar {...actions} view={view} /></>
    const { rerender, container } = render(renderBar({ ...connected, status: { ...connected.status!, state: 'connecting', peers: [] } }))
    const editor = screen.getByRole('textbox', { name: 'Editor' })
    editor.focus()
    rerender(renderBar(connected))
    expect(screen.getByRole('region', { name: 'Active collaborators' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Collaboration' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(`pubky${peerOwner}`)).toBeTruthy()
    await screen.findByText('Known collaborator')
    await screen.findByText('You don’t follow this person.')
    expect(screen.getByText(/Check their Pubky identifier; names and pictures can be copied/)).toBeTruthy()
    await waitFor(() => expect(container.querySelector('img')?.src).toBe('blob:collaborator-avatar'))
    expect(mocks.profile).toHaveBeenCalledWith(peerOwner, expect.any(AbortSignal))
    expect(mocks.follow).toHaveBeenCalledWith(ownOwner, peerOwner, expect.any(AbortSignal))
    expect(mocks.avatar).toHaveBeenCalledWith(peerOwner, `pubky${peerOwner}/pub/avatar.png`, expect.any(AbortSignal))
    expect(document.activeElement).toBe(editor)
    expect(screen.queryByRole('button', { name: 'Allow collaborator' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Join collaboration' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy verified Pubky identifier' }))
    expect(actions.copy).toHaveBeenCalledExactlyOnceWith(`pubky${peerOwner}`)
    fireEvent.click(screen.getByRole('button', { name: 'Shared research' }))
    expect(actions.openNote).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect collaboration' }))
    expect(actions.disconnect).toHaveBeenCalledOnce()
    rerender(renderBar({ ...connected, status: { ...connected.status!, state: 'disconnected' } }))
    expect(screen.queryByRole('region', { name: 'Active collaborators' })).toBeNull()
    expect(screen.queryByText(`pubky${peerOwner}`)).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:collaborator-avatar')
  })

  it('keeps a warning when following cannot be checked without treating the person as followed', async () => {
    mocks.follow.mockResolvedValue({ state: 'unknown', error: 'Private server failure details' })
    render(<CollaborationBar {...props()} />)
    await screen.findByText('Could not check whether you follow this person.')
    expect(screen.getByText(/Check their Pubky identifier; names and pictures can be copied/)).toBeTruthy()
    expect(screen.getByText(`pubky${peerOwner}`)).toBeTruthy()
    expect(screen.queryByText('You follow this person.')).toBeNull()
    expect(screen.queryByText('You don’t follow this person.')).toBeNull()
    expect(screen.queryByText('Private server failure details')).toBeNull()
  })

  it('shows a confirmed follow relationship without the impersonation warning', async () => {
    mocks.follow.mockResolvedValue({ state: 'following' })
    render(<CollaborationBar {...props()} />)
    await screen.findByText('You follow this person.')
    expect(screen.getByText(`pubky${peerOwner}`)).toBeTruthy()
    expect(screen.queryByText(/names and pictures can be copied/)).toBeNull()
  })

  it.each([undefined, '', 'https://untrusted.example/profile', `pubky${peerOwner}`])('does not show or fetch an identity without a canonical verified transport identifier: %s', peerIdentity => {
    render(<CollaborationBar {...props()} view={{ ...connected, status: { ...connected.status!, peers: [{ ...connected.status!.peers[0], owner: peerIdentity as string }] } }} />)
    expect(screen.queryByRole('region', { name: 'Active collaborators' })).toBeNull()
    expect(mocks.profile).not.toHaveBeenCalled()
    expect(mocks.avatar).not.toHaveBeenCalled()
    expect(mocks.follow).not.toHaveBeenCalled()
  })
})

it('shows every connected verified identity and checks each follow relationship independently', async () => {
  const secondOwner = 'c'.repeat(52)
  mocks.profile.mockImplementation(async (owner: string) => ({ name: owner === peerOwner ? 'First person' : 'Second person' }))
  mocks.follow.mockImplementation(async (_own: string, owner: string) => ({ state: owner === peerOwner ? 'following' : 'not-following' }))
  render(<CollaborationBar {...props()} view={{ ...connected, status: { ...connected.status!, participantCount: 3, creatorOnline: false,
    peers: [...connected.status!.peers, { key: 'second', session: 'session-2', owner: secondOwner, presenceSupported: true }] } }} />)
  expect(screen.getByRole('list', { name: 'Connected collaborators' }).tabIndex).toBe(0)
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getByText('3 online ·')).toBeTruthy()
  await screen.findByText('First person'); await screen.findByText('Second person')
  expect(screen.getByText(`pubky${peerOwner}`)).toBeTruthy()
  expect(screen.getByText(`pubky${secondOwner}`)).toBeTruthy()
  await screen.findByText('You follow this person.'); await screen.findByText('You don’t follow this person.')
  expect(mocks.follow).toHaveBeenCalledWith(ownOwner, secondOwner, expect.any(AbortSignal))
})
