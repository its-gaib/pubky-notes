import { Copy, UsersRound, X } from 'lucide-react'
import type { CollaborationView } from '../hooks/useCollaboration'
import type { Note } from '../lib/notes'
import { WEBRTC_UNAVAILABLE_MESSAGE } from '../lib/collaboration/transport'

interface Props {
  invitation: boolean
  view: CollaborationView
  note?: Note
  sharedTitle?: string
  signedIn: boolean
  disabled: boolean
  close(): void
  connect(): void
  start(): void
  join(): void
  retry(): void
  disconnect(): void
  copy(link: string): void
}

export function collaborationStatusLabel(view: CollaborationView): string {
  if (view.status?.issue || view.error) return 'Connection problem'
  switch (view.status?.state) {
    case 'connected': return view.peerReceived ? 'Everyone connected received your edits' : 'Connected'
    case 'waiting': return 'Waiting for collaborators'
    case 'disconnected': return 'Disconnected'
    case 'error': return 'Connection problem'
    default: return 'Connecting…'
  }
}

/** Optional invitation and connection controls. Never steals editor focus. */
export default function CollaborationPanel(props: Props) {
  const { invitation, view, note, signedIn, disabled } = props
  const active = !!view.noteId && !invitation
  const failed = !!view.status?.issue || view.status?.state === 'error' || view.status?.state === 'disconnected' || !!view.error
  const unavailable = view.status?.issue === 'webrtc-unavailable'
  const connectionMessage = unavailable ? WEBRTC_UNAVAILABLE_MESSAGE
    : view.status?.issue === 'identity-unavailable'
    ? 'Connect your Pubky account again to verify your identity for collaboration.'
    : view.status?.issue === 'identity-verification-failed'
    ? 'The other person’s Pubky identity could not be verified. Ask them to reconnect their Pubky account, then retry.'
    : view.status?.issue === 'account-already-joined'
    ? 'Your Pubky account already has a place in this group in another browser. Reopen the shared note in that browser.'
    : view.status?.issue === 'room-full'
    ? 'This shared note has reached its limit of 10 people, including its creator. Create a new shared copy to work with a different group.'
    : view.status?.issue === 'handshake-failed'
    ? 'The browsers did not finish setting up the connection. Check the other browser for an error, keep the shared note open, then retry.'
    : view.status?.issue === 'direct-connection-failed'
    ? 'Could not establish a direct connection. The TURN relay needed to sync edits between these networks is unavailable. You can keep editing your private copy.'
    : view.status?.issue === 'connection-failed'
      ? 'The connection failed. Check that your collaborators are online, then retry.'
      : view.error
  return <section id="collaboration-panel" className="collaboration-panel" aria-label="Collaboration">
    <header className="collaboration-panel-heading"><span><UsersRound size={15} />{invitation ? 'Join shared note' : active ? props.sharedTitle || 'Shared note' : 'Collaborate'}</span><button className="icon-button" aria-label="Close collaboration" title="Close collaboration" onClick={props.close}><X size={17} /></button></header>
    {invitation ? <>
      <p>This link joins the shared note automatically once you’re signed in. The shared note saves privately to your homeserver. The creator must be online when you first join; connected collaborators can keep editing together afterward.</p>
      {signedIn && <p className="collaboration-panel-status" role="status">{view.error ? 'Connection problem' : view.status ? collaborationStatusLabel(view) : 'Joining…'}</p>}
      {connectionMessage && <p className="inline-error" role="alert">{connectionMessage}</p>}
      {!signedIn ? <div className="collaboration-panel-actions"><button className="button primary small" disabled={disabled || view.working} onClick={props.connect}>Connect Pubky to join</button></div>
        : failed && <div className="collaboration-panel-actions"><button className="button secondary small" disabled={disabled || view.working} onClick={props.join}>Retry connection</button></div>}
    </> : active ? <>
      <p className="collaboration-panel-status" role="status">{collaborationStatusLabel(view)}</p>
      {connectionMessage && <p className="inline-error" role="alert">{connectionMessage}</p>}
      {view.status && <p className="hint">{view.status.participantCount} of {view.status.maxParticipants} participant places used, including the creator. Places stay assigned to this group.</p>}
      {view.role === 'guest' && view.status && !view.status.creatorOnline && <p className="hint">The creator is offline. Existing participants can keep syncing; new people can join when the creator returns.</p>}
      {view.link && <div className="collaboration-invitation"><input aria-label="Invitation link" readOnly value={view.link} onFocus={event => event.target.select()} /><button className="button secondary small" aria-label="Copy invitation link" onClick={() => props.copy(view.link!)}><Copy size={15} /> Copy link</button></div>}
      {failed && <div className="collaboration-panel-actions"><button className="button secondary small" onClick={props.retry}>Retry connection</button></div>}
      <details className="collaboration-details"><summary>Details</summary>
        <p>Each person saves the shared note privately. Folders and Trash stay personal. Online collaborators sync with each other; offline edits merge when you reconnect. Use one browser per Pubky account in this group.</p>
        {view.status && !unavailable && <p>{view.status.relayAvailable ? 'TURN relay fallback for syncing edits is configured.' : 'Direct connections only: the TURN relay for syncing edits is unavailable.'}</p>}
        {view.error && view.error !== connectionMessage && <p>{view.error}</p>}
        <button className="button ghost small" onClick={props.disconnect}>Disconnect collaboration</button>
      </details>
    </> : <>
      <p>{note?.crdt?.version === 2 ? 'Resume editing this shared note. It saves privately to your homeserver.' : 'Creates a shared copy of the current text, without your earlier editing history or deleted text. Your original stays unchanged.'}</p>
      <p className="hint">Anyone with your invitation link can join automatically, up to 10 people including you. Keep this note open while new people join. Each person saves a private copy; existing participants can keep syncing when you leave.</p>
      {view.error && <p className="inline-error" role="alert">{view.error}</p>}
      <div className="collaboration-panel-actions"><button className="button primary small" disabled={disabled || view.working || (signedIn && !note)} onClick={signedIn ? props.start : props.connect}>{!signedIn ? 'Connect Pubky' : view.working ? 'Preparing…' : note?.crdt?.version === 2 ? 'Resume collaboration' : 'Create shared copy'}</button></div>
    </>}
  </section>
}
