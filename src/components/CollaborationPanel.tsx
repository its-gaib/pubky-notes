import { Copy, UsersRound, X } from 'lucide-react'
import type { CollaborationView } from '../hooks/useCollaboration'
import type { Note } from '../lib/notes'

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
  approve(): void
  reject(): void
  retry(): void
  disconnect(): void
  copy(link: string): void
}

export function collaborationStatusLabel(view: CollaborationView): string {
  if (view.request) return 'Approval needed'
  if (view.status?.issue || view.error) return 'Connection problem'
  switch (view.status?.state) {
    case 'connected': return view.peerReceived ? 'Peer received' : 'Connected'
    case 'approval': return 'Waiting for approval'
    case 'waiting': return 'Waiting for collaborator'
    case 'disconnected': return 'Disconnected'
    case 'error': return 'Connection problem'
    default: return 'Connecting…'
  }
}

/** One inline surface for consent, approval, and connection controls. Never steals editor focus. */
export default function CollaborationPanel(props: Props) {
  const { invitation, view, note, signedIn, disabled } = props
  const active = !!view.noteId && !invitation
  const failed = !!view.status?.issue || view.status?.state === 'error' || view.status?.state === 'disconnected' || !!view.error
  const connectionMessage = view.status?.issue === 'direct-connection-failed'
    ? 'Could not establish a direct connection. The TURN relay for syncing edits is unavailable. Keep both browsers online or try another network.'
    : view.status?.issue === 'connection-failed'
      ? 'The connection failed. Check that both people are online, then retry.'
      : view.error
  return <section id="collaboration-panel" className="collaboration-panel" aria-label="Collaboration">
    <header className="collaboration-panel-heading"><span><UsersRound size={15} />{invitation ? 'Join shared note' : active ? props.sharedTitle || 'Shared note' : 'Collaborate'}</span><button className="icon-button" aria-label="Close collaboration" title="Close collaboration" onClick={props.close}><X size={17} /></button></header>
    {invitation ? <>
      <p>Edit together after the inviter approves. Your copy saves privately to your homeserver; both browsers must be online to sync.</p>
      {view.error && <p className="inline-error" role="alert">{view.error}</p>}
      <div className="collaboration-panel-actions"><button className="button primary small" disabled={disabled || view.working} onClick={signedIn ? props.join : props.connect}>{signedIn ? view.working ? 'Joining…' : 'Join collaboration' : 'Connect Pubky to join'}</button></div>
    </> : active ? <>
      <p className="collaboration-panel-status" role="status">{collaborationStatusLabel(view)}</p>
      {connectionMessage && <p className="inline-error" role="alert">{connectionMessage}</p>}
      {view.request ? <div className="collaboration-request">
        <p>Allow this person to edit?</p>
        <p className="hint">Compare code <strong>{view.request.fingerprint}</strong> with your invitee. It identifies their browser, not a verified Pubky profile.</p>
        <div className="collaboration-panel-actions"><button className="button primary small" disabled={view.working} onClick={props.approve}>Allow collaborator</button><button className="button ghost small" onClick={props.reject}>Decline</button></div>
      </div> : view.link && <div className="collaboration-invitation"><input aria-label="Invitation link" readOnly value={view.link} onFocus={event => event.target.select()} /><button className="button secondary small" aria-label="Copy invitation link" onClick={() => props.copy(view.link!)}><Copy size={15} /> Copy link</button></div>}
      {view.role === 'guest' && view.ownFingerprint && view.status?.state !== 'connected' && <p className="hint">Your connection code: <strong>{view.ownFingerprint}</strong>. Share it with the inviter.</p>}
      {failed && <div className="collaboration-panel-actions"><button className="button secondary small" onClick={props.retry}>Retry connection</button></div>}
      <details className="collaboration-details"><summary>Details</summary>
        <p>Each person saves a private copy. Folders and Trash stay personal. Both browsers must be online to sync.</p>
        {view.status && <p>{view.status.relayAvailable ? 'TURN relay fallback for syncing edits is configured.' : 'Direct connections only: the TURN relay for syncing edits is unavailable.'}</p>}
        {view.error && view.error !== connectionMessage && <p>{view.error}</p>}
        <button className="button ghost small" onClick={props.disconnect}>Disconnect collaboration</button>
      </details>
    </> : <>
      <p>{note?.crdt?.version === 2 ? 'Resume editing this shared note. Your copy stays private.' : 'Creates a shared copy of the current text; your original stays private and unchanged.'}</p>
      <p className="hint">Invite one person. Each keeps a private copy; both browsers must be online to sync.</p>
      {view.error && <p className="inline-error" role="alert">{view.error}</p>}
      <div className="collaboration-panel-actions"><button className="button primary small" disabled={disabled || view.working || (signedIn && !note)} onClick={signedIn ? props.start : props.connect}>{!signedIn ? 'Connect Pubky' : view.working ? 'Preparing…' : note?.crdt?.version === 2 ? 'Resume collaboration' : 'Create shared copy'}</button></div>
    </>}
  </section>
}
