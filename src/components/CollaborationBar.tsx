import { LogOut, UsersRound } from 'lucide-react'
import type { CollaborationView } from '../hooks/useCollaboration'
import PeerIdentity, { isCanonicalPubkyId } from './PeerIdentity'

interface Props {
  view: CollaborationView
  ownOwner?: string
  sharedTitle?: string
  openNote(): void
  disconnect(): void
  copy(value: string): void
}

/** The live participant indicator is independent of the optional controls panel. */
export default function CollaborationBar({ view, ownOwner, sharedTitle, openNote, disconnect, copy }: Props) {
  const owner = view.status?.peerIdentity
  if (view.status?.state !== 'connected' || !isCanonicalPubkyId(owner)) return null
  return <section className="collaboration-bar" aria-label="Active collaborators">
    <div className="collaboration-bar-heading">
      <UsersRound size={14} aria-hidden="true" />
      <span>Collaborating on</span>
      <button type="button" className="collaboration-bar-note" onClick={openNote} title={sharedTitle || 'Shared note'}>{sharedTitle || 'Shared note'}</button>
      <button type="button" className="icon-button" aria-label="Disconnect collaboration" title="Disconnect collaboration" onClick={disconnect}><LogOut size={15} /></button>
    </div>
    <PeerIdentity owner={owner} ownOwner={ownOwner} copy={copy} compact />
  </section>
}
