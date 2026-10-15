// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { CollaborationView } from '../hooks/useCollaboration'
import CollaborationPanel, { collaborationStatusLabel } from './CollaborationPanel'

const mocks = vi.hoisted(() => ({ profile: vi.fn(), follow: vi.fn(), avatar: vi.fn() }))
vi.mock('../lib/peer-profile', () => ({ loadPeerProfile: mocks.profile, loadFollowRelationship: mocks.follow, loadPeerAvatar: mocks.avatar }))
const peerOwner = 'y'.repeat(52), ownOwner = 'b'.repeat(52)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.profile.mockResolvedValue({ name: 'Known collaborator' })
  mocks.follow.mockResolvedValue({ state: 'not-following' })
})

const initial: CollaborationView = { peerReceived: false, working: false }
function props(overrides: Partial<ComponentProps<typeof CollaborationPanel>> = {}): ComponentProps<typeof CollaborationPanel> {
  return { invitation: false, view: initial, signedIn: true, ownOwner, disabled: false,
    note: { id: 'note', title: 'Private draft', content: 'Words', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
    close: vi.fn(), connect: vi.fn(), start: vi.fn(), join: vi.fn(), approve: vi.fn(), reject: vi.fn(), retry: vi.fn(), disconnect: vi.fn(), copy: vi.fn(), ...overrides }
}
const waiting: CollaborationView = { ...initial, noteId: 'shared', role: 'host', link: 'https://notes.example/#collaborate=secret', status: { state: 'waiting', relayAvailable: false } }
afterEach(cleanup)

describe('inline collaboration', () => {
  it('requires explicit consent before creating a shared copy and does not show redundant buttons', () => {
    const actions = props()
    render(<CollaborationPanel {...actions} />)
    expect(screen.getByRole('region', { name: 'Collaboration' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(/earlier editing history or deleted text.*original stays unchanged/)).toBeTruthy()
    expect(actions.start).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create shared copy' }))
    expect(actions.start).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Close collaboration' }))
    expect(actions.close).toHaveBeenCalledOnce()
  })

  it('keeps invitation consent after sign-in instead of automatically joining', () => {
    const actions = props({ invitation: true, signedIn: false })
    const { rerender } = render(<CollaborationPanel {...actions} />)
    expect(screen.getByText(/shared note saves privately.*both browsers must be online/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Pubky to join' }))
    expect(actions.connect).toHaveBeenCalledOnce()
    expect(actions.join).not.toHaveBeenCalled()
    rerender(<CollaborationPanel {...actions} signedIn />)
    expect(actions.join).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Join collaboration' }))
    expect(actions.join).toHaveBeenCalledOnce()
  })

  it('presents the verified account and follow warning without stealing typing focus', async () => {
    const actions = props({ view: waiting })
    const renderPanel = (view: CollaborationView) => <><textarea aria-label="Editor" /><CollaborationPanel {...actions} view={view} /></>
    const { rerender } = render(renderPanel(waiting))
    screen.getByRole('textbox', { name: 'Editor' }).focus()
    rerender(renderPanel({ ...waiting, request: { peerId: 'browser-key', fingerprint: 'ABCD 1234', owner: peerOwner } }))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Editor' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('ABCD 1234')).toBeNull()
    expect(screen.getByText(`pubky${peerOwner}`)).toBeTruthy()
    await screen.findByText('Known collaborator')
    await screen.findByText('You don’t follow this person.')
    expect(mocks.profile).toHaveBeenCalledWith(peerOwner, expect.any(AbortSignal))
    expect(mocks.follow).toHaveBeenCalledWith(ownOwner, peerOwner, expect.any(AbortSignal))
    expect(actions.approve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Allow collaborator' }))
    expect(actions.approve).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(actions.reject).toHaveBeenCalledOnce()
  })

  it('keeps copy link primary and puts optional connection controls under details', () => {
    const actions = props({ view: waiting })
    render(<CollaborationPanel {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy invitation link' }))
    expect(actions.copy).toHaveBeenCalledWith(waiting.link)
    expect((screen.getByRole('textbox', { name: 'Invitation link' }) as HTMLInputElement).readOnly).toBe(true)
    expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
    const details = screen.getByText('Details').closest('details')!
    expect(details.open).toBe(false)
    expect(within(details).getByText('Direct connections only: the TURN relay for syncing edits is unavailable.')).toBeTruthy()
    fireEvent.click(within(details).getByText('Disconnect collaboration'))
    expect(actions.disconnect).toHaveBeenCalledOnce()
  })

  it('shows an actionable direct-connection failure throughout automatic retries, then clears on success', () => {
    const actions = props({ view: { ...waiting, status: { state: 'connecting', relayAvailable: false, issue: 'direct-connection-failed' } } })
    const { rerender } = render(<CollaborationPanel {...actions} />)
    expect(screen.getByRole('alert').textContent).toContain('The TURN relay needed to sync edits between these networks is unavailable')
    expect(screen.getByRole('status').textContent).toBe('Connection problem')
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    expect(actions.retry).toHaveBeenCalledOnce()
    rerender(<CollaborationPanel {...actions} view={{ ...waiting, status: { state: 'connected', relayAvailable: true } }} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Connected')
  })

  it('explains missing WebRTC without suggesting a TURN relay can fix the browser', () => {
    const actions = props({ view: { ...waiting, status: { state: 'error', relayAvailable: false, issue: 'webrtc-unavailable' } } })
    render(<CollaborationPanel {...actions} />)
    expect(screen.getByRole('alert').textContent).toContain('WebRTC, which is disabled or unavailable in this browser')
    expect(screen.getByRole('alert').textContent).toContain('Tor Browser does not support this connection method')
    expect(screen.queryByText(/TURN relay/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    expect(actions.retry).toHaveBeenCalledOnce()
  })

  it('explains an unfinished handshake separately from TURN availability', () => {
    render(<CollaborationPanel {...props({ view: { ...waiting, status: { state: 'connecting', relayAvailable: false, issue: 'handshake-failed' } } })} />)
    expect(screen.getByRole('alert').textContent).toContain('Check the other browser for an error')
    expect(screen.getByRole('alert').textContent).not.toContain('TURN')
    const details = screen.getByText('Details').closest('details')!
    expect(within(details).getByText('Direct connections only: the TURN relay for syncing edits is unavailable.')).toBeTruthy()
  })

  it('shows the verified inviter while the guest waits for approval, without connection codes', async () => {
    const actions = props({ view: { ...waiting, role: 'guest', link: undefined, ownFingerprint: '4321 DCBA', status: { state: 'approval', relayAvailable: true, peerIdentity: peerOwner } } })
    const { rerender } = render(<CollaborationPanel {...actions} />)
    expect(screen.getByRole('status').textContent).toBe('Waiting for approval')
    expect(screen.queryByText('4321 DCBA')).toBeNull()
    expect(screen.getByText(`pubky${peerOwner}`)).toBeTruthy()
    await screen.findByText('Known collaborator')
    expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
    rerender(<CollaborationPanel {...actions} view={{ ...waiting, status: { state: 'connecting', relayAvailable: true } }} />)
    expect(screen.getByRole('status').textContent).toBe('Connecting…')
    expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
    expect(collaborationStatusLabel({ ...waiting, status: { state: 'disconnected', relayAvailable: false } })).toBe('Disconnected')
  })

  it('does not offer approval or fetch a profile when a request has no verified account identifier', () => {
    const actions = props({ view: { ...waiting, status: { state: 'waiting', relayAvailable: false, peerIdentity: peerOwner }, request: { peerId: 'browser-key', fingerprint: 'ABCD 1234', owner: '' } } })
    render(<CollaborationPanel {...actions} />)
    expect(screen.getByRole('alert').textContent).toContain('Pubky identity could not be verified')
    expect(screen.queryByRole('button', { name: 'Allow collaborator' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy verified Pubky identifier' })).toBeNull()
    expect(mocks.profile).not.toHaveBeenCalled()
    expect(mocks.follow).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(actions.reject).toHaveBeenCalledOnce()
  })

  it('keeps explicit approval available when the follow lookup is unknown', async () => {
    mocks.follow.mockResolvedValue({ state: 'unknown', error: 'Private server failure details' })
    const actions = props({ view: { ...waiting, request: { peerId: 'browser-key', fingerprint: 'ABCD 1234', owner: peerOwner } } })
    render(<CollaborationPanel {...actions} />)
    await screen.findByText('Could not check whether you follow this person.')
    expect(screen.queryByText('Private server failure details')).toBeNull()
    expect(screen.queryByText('You don’t follow this person.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Allow collaborator' }))
    expect(actions.approve).toHaveBeenCalledOnce()
  })
})
