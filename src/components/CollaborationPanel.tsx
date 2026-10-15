import { Copy, UsersRound, X } from 'lucide-react'
import type { CollaborationView } from '../hooks/useCollaboration'
import type { Note } from '../lib/notes'
import { WEBRTC_UNAVAILABLE_MESSAGE } from '../lib/collaboration/transport'
import PeerIdentity, { isCanonicalPubkyId } from './PeerIdentity'

interface Props {
  invitation: boolean
  view: CollaborationView
  note?: Note
  sharedTitle?: string
  signedIn: boolean
  ownOwner?: string
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
  const unavailable = view.status?.issue === 'webrtc-unavailable'
  const verifiedRequest = view.request && isCanonicalPubkyId(view.request.owner)
  const peerOwner = view.request ? view.request.owner : view.status?.peerIdentity
  const connectionMessage = unavailable ? WEBRTC_UNAVAILABLE_MESSAGE
    : view.status?.issue === 'identity-unavailable'
    ? 'Connect your Pubky account again to verify your identity for collaboration.'
    : view.status?.issue === 'identity-verification-failed'
    ? 'The other person’s Pubky identity could not be verified. Ask them to reconnect their Pubky account, then retry.'
    : view.status?.issue === 'handshake-failed'
    ? 'The browsers did not finish setting up the connection. Check the other browser for an error, keep both notes open, then retry.'
    : view.status?.issue === 'direct-connection-failed'
    ? 'Could not establish a direct connection. The TURN relay needed to sync edits between these networks is unavailable. You can keep editing your private copy.'
    : view.status?.issue === 'connection-failed'
      ? 'The connection failed. Check that both people are online, then retry.'
      : view.error
  return <section id="collaboration-panel" className="collaboration-panel" aria-label="Collaboration">
    <header className="collaboration-panel-heading"><span><UsersRound size={15} />{invitation ? 'Join shared note' : active ? props.sharedTitle || 'Shared note' : 'Collaborate'}</span><button className="icon-button" aria-label="Close collaboration" title="Close collaboration" onClick={props.close}><X size={17} /></button></header>
    {invitation ? <>
      <p>Edit together after the inviter approves. The shared note saves privately to your homeserver; both browsers must be online to sync.</p>
      {view.error && <p className="inline-error" role="alert">{view.error}</p>}
      <div className="collaboration-panel-actions"><button className="button primary small" disabled={disabled || view.working} onClick={signedIn ? props.join : props.connect}>{signedIn ? view.working ? 'Joining…' : 'Join collaboration' : 'Connect Pubky to join'}</button></div>
    </> : active ? <>
      <p className="collaboration-panel-status" role="status">{collaborationStatusLabel(view)}</p>
      {connectionMessage && <p className="inline-error" role="alert">{connectionMessage}</p>}
      {peerOwner && isCanonicalPubkyId(peerOwner) && <PeerIdentity owner={peerOwner} ownOwner={props.ownOwner} copy={props.copy} />}
      {view.request ? <div className="collaboration-request">
        {verifiedRequest ? <p>Allow this person to edit?</p> : <p className="inline-error" role="alert">This person’s Pubky identity could not be verified.</p>}
        <div className="collaboration-panel-actions">{verifiedRequest && <button className="button primary small" disabled={view.working} onClick={props.approve}>Allow collaborator</button>}<button className="button ghost small" onClick={props.reject}>Decline</button></div>
      </div> : view.link && <div className="collaboration-invitation"><input aria-label="Invitation link" readOnly value={view.link} onFocus={event => event.target.select()} /><button className="button secondary small" aria-label="Copy invitation link" onClick={() => props.copy(view.link!)}><Copy size={15} /> Copy link</button></div>}
      {failed && <div className="collaboration-panel-actions"><button className="button secondary small" onClick={props.retry}>Retry connection</button></div>}
      <details className="collaboration-details"><summary>Details</summary>
        <p>Each person saves the shared note privately. Folders and Trash stay personal. Both browsers must be online to sync.</p>
        {view.status && !unavailable && <p>{view.status.relayAvailable ? 'TURN relay fallback for syncing edits is configured.' : 'Direct connections only: the TURN relay for syncing edits is unavailable.'}</p>}
        {view.error && view.error !== connectionMessage && <p>{view.error}</p>}
        <button className="button ghost small" onClick={props.disconnect}>Disconnect collaboration</button>
      </details>
    </> : <>
      <p>{note?.crdt?.version === 2 ? 'Resume editing this shared note. It saves privately to your homeserver.' : 'Creates a shared copy of the current text, without your earlier editing history or deleted text. Your original stays unchanged.'}</p>
      <p className="hint">Invite one person. Each of you saves the shared note privately; both browsers must be online to sync.</p>
      {view.error && <p className="inline-error" role="alert">{view.error}</p>}
      <div className="collaboration-panel-actions"><button className="button primary small" disabled={disabled || view.working || (signedIn && !note)} onClick={signedIn ? props.start : props.connect}>{!signedIn ? 'Connect Pubky' : view.working ? 'Preparing…' : note?.crdt?.version === 2 ? 'Resume collaboration' : 'Create shared copy'}</button></div>
    </>}
  </section>
}
