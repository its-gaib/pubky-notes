// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { CollaborationView } from '../hooks/useCollaboration'
import CollaborationPanel, { collaborationStatusLabel } from './CollaborationPanel'

const initial: CollaborationView = { peerReceived: false, working: false }
function props(overrides: Partial<ComponentProps<typeof CollaborationPanel>> = {}): ComponentProps<typeof CollaborationPanel> {
  return { invitation: false, view: initial, signedIn: true, disabled: false,
    note: { id: 'note', title: 'Private draft', content: 'Words', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
    close: vi.fn(), connect: vi.fn(), start: vi.fn(), join: vi.fn(), retry: vi.fn(), disconnect: vi.fn(), copy: vi.fn(), ...overrides }
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

  it('offers sign-in for an invitation and shows automatic joining without another action afterward', () => {
    const actions = props({ invitation: true, signedIn: false })
    const { rerender } = render(<CollaborationPanel {...actions} />)
    expect(screen.getByText(/shared note saves privately.*both browsers must be online/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Pubky to join' }))
    expect(actions.connect).toHaveBeenCalledOnce()
    expect(actions.join).not.toHaveBeenCalled()
    rerender(<CollaborationPanel {...actions} signedIn />)
    expect(screen.getByRole('status').textContent).toBe('Joining…')
    expect(screen.queryByRole('button', { name: 'Join collaboration' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect Pubky to join' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
    expect(actions.join).not.toHaveBeenCalled()
  })

  it('retries a failed invitation through joining, without creating or reconnecting another room', () => {
    const actions = props({ invitation: true, view: { ...initial, error: 'Could not join this shared note.' } })
    render(<CollaborationPanel {...actions} />)
    expect(screen.getByRole('alert').textContent).toBe('Could not join this shared note.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    expect(actions.join).toHaveBeenCalledOnce()
    expect(actions.start).not.toHaveBeenCalled()
    expect(actions.retry).not.toHaveBeenCalled()
  })

  it('updates connection status without approval controls or stealing typing focus', () => {
    const actions = props({ view: waiting })
    const renderPanel = (view: CollaborationView) => <><textarea aria-label="Editor" /><CollaborationPanel {...actions} view={view} /></>
    const { rerender } = render(renderPanel(waiting))
    screen.getByRole('textbox', { name: 'Editor' }).focus()
    rerender(renderPanel({ ...waiting, status: { state: 'connected', relayAvailable: true, peerIdentity: 'y'.repeat(52) } }))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Editor' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Connected')
    expect(screen.queryByRole('button', { name: 'Allow collaborator' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Join collaboration' })).toBeNull()
  })

  it('explains a transport failure before the invitation document has been saved and allows retry', () => {
    const actions = props({ invitation: true, view: { ...initial, noteId: 'shared', role: 'guest',
      status: { state: 'connecting', relayAvailable: false, issue: 'direct-connection-failed' } } })
    render(<CollaborationPanel {...actions} />)
    expect(screen.getByRole('status').textContent).toBe('Connection problem')
    expect(screen.getByRole('alert').textContent).toContain('The TURN relay needed to sync edits between these networks is unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    expect(actions.join).toHaveBeenCalledOnce()
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

  it('shows the guest connection status without connection codes or an approval step', () => {
    const actions = props({ view: { ...waiting, role: 'guest', link: undefined, ownFingerprint: '4321 DCBA', status: { state: 'connecting', relayAvailable: true, peerIdentity: 'y'.repeat(52) } } })
    const { rerender } = render(<CollaborationPanel {...actions} />)
    expect(screen.getByRole('status').textContent).toBe('Connecting…')
    expect(screen.queryByText('4321 DCBA')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
    expect(screen.queryByText('Waiting for approval')).toBeNull()
    rerender(<CollaborationPanel {...actions} view={{ ...waiting, status: { state: 'connected', relayAvailable: true } }} />)
    expect(screen.getByRole('status').textContent).toBe('Connected')
    expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
    expect(collaborationStatusLabel({ ...waiting, status: { state: 'disconnected', relayAvailable: false } })).toBe('Disconnected')
  })

})
