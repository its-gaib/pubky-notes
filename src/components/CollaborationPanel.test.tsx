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

  it('presents incoming approval without stealing typing focus and always displays the browser fingerprint', () => {
    const actions = props({ view: waiting })
    const renderPanel = (view: CollaborationView) => <><textarea aria-label="Editor" /><CollaborationPanel {...actions} view={view} /></>
    const { rerender } = render(renderPanel(waiting))
    screen.getByRole('textbox', { name: 'Editor' }).focus()
    rerender(renderPanel({ ...waiting, request: { peerId: 'browser-key', fingerprint: 'ABCD 1234' } }))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Editor' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('ABCD 1234')).toBeTruthy()
    expect(screen.getByText(/not a verified Pubky profile/)).toBeTruthy()
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
    expect(screen.getByRole('alert').textContent).toContain('The TURN relay for syncing edits is unavailable')
    expect(screen.getByRole('status').textContent).toBe('Connection problem')
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    expect(actions.retry).toHaveBeenCalledOnce()
    rerender(<CollaborationPanel {...actions} view={{ ...waiting, status: { state: 'connected', relayAvailable: true } }} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Connected')
  })

  it('uses normal connecting and guest approval states, without calling the collaborator offline', () => {
    const actions = props({ view: { ...waiting, role: 'guest', link: undefined, ownFingerprint: '4321 DCBA', status: { state: 'approval', relayAvailable: true } } })
    const { rerender } = render(<CollaborationPanel {...actions} />)
    expect(screen.getByRole('status').textContent).toBe('Waiting for approval')
    expect(screen.getByText('4321 DCBA')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
    rerender(<CollaborationPanel {...actions} view={{ ...waiting, status: { state: 'connecting', relayAvailable: true } }} />)
    expect(screen.getByRole('status').textContent).toBe('Connecting…')
    expect(screen.queryByRole('button', { name: 'Retry connection' })).toBeNull()
    expect(collaborationStatusLabel({ ...waiting, status: { state: 'disconnected', relayAvailable: false } })).toBe('Disconnected')
  })
})
