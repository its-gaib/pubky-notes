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
  const peers = view.status?.peers.filter(peer => isCanonicalPubkyId(peer.owner)) ?? []
  if (view.status?.state !== 'connected' || !peers.length) return null
  return <section className="collaboration-bar" aria-label="Active collaborators">
    <div className="collaboration-bar-heading">
      <UsersRound size={14} aria-hidden="true" />
      <span>{peers.length + 1} online ·</span><span>Collaborating on</span>
      <button type="button" className="collaboration-bar-note" onClick={openNote} title={sharedTitle || 'Shared note'}>{sharedTitle || 'Shared note'}</button>
      <button type="button" className="icon-button" aria-label="Disconnect collaboration" title="Disconnect collaboration" onClick={disconnect}><LogOut size={15} /></button>
    </div>
    <div className="collaboration-roster" role="list" aria-label="Connected collaborators" tabIndex={0}>
      {peers.map(peer => <div className="collaboration-roster-person" role="listitem" key={`${peer.key}:${peer.session}`}>
        <PeerIdentity owner={peer.owner} ownOwner={ownOwner} copy={copy} compact />
      </div>)}
    </div>
  </section>
}
