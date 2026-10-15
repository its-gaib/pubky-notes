import { useEffect, useState } from 'react'
import { Copy, ShieldCheck } from 'lucide-react'
import { loadFollowRelationship, loadPeerAvatar, loadPeerProfile } from '../lib/peer-profile'
import './PeerIdentity.css'

interface Props {
  /** The transport supplies this only after verifying the peer's account proof. */
  owner: string
  ownOwner?: string
  copy(value: string): void
}

export function isCanonicalPubkyId(value: unknown): value is string {
  return typeof value === 'string' && /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(value)
}

export default function PeerIdentity(props: Props) {
  if (!isCanonicalPubkyId(props.owner)) return <p className="inline-error">This person’s Pubky identity could not be verified.</p>
  // Reset synchronously when either account changes, before late requests settle.
  return <VerifiedIdentity key={`${props.ownOwner || ''}:${props.owner}`} {...props} />
}

function VerifiedIdentity({ owner, ownOwner, copy }: Props) {
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState('')
  const [profileState, setProfileState] = useState<'loading' | 'available' | 'unavailable'>('loading')
  const [follow, setFollow] = useState<'loading' | 'following' | 'not-following' | 'unknown'>(ownOwner ? 'loading' : 'unknown')
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    void (async () => {
      try {
        const profile = await loadPeerProfile(owner, controller.signal)
        if (controller.signal.aborted) return
        setName(profile.name)
        setProfileState('available')
        if (profile.image) {
          try {
            const blob = await loadPeerAvatar(owner, profile.image, controller.signal)
            if (controller.signal.aborted) return
            objectUrl = URL.createObjectURL(blob)
            setAvatar(objectUrl)
          } catch { /* The verified identifier remains usable without a photo. */ }
        }
      } catch { if (!controller.signal.aborted) setProfileState('unavailable') }
    })()
    if (ownOwner) void (async () => {
      try {
        const relationship = await loadFollowRelationship(ownOwner, owner, controller.signal)
        if (!controller.signal.aborted) setFollow(relationship.state)
      } catch { if (!controller.signal.aborted) setFollow('unknown') }
    })()
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [owner, ownOwner])
  const identifier = `pubky${owner}`
  const initials = name ? name.split(/\s+/u).slice(0, 2).map(word => [...word][0]).join('').toUpperCase() : owner.slice(0, 2).toUpperCase()
  return <div className="peer-identity" aria-label="Verified collaborator identity">
    <div className="peer-identity-heading">
      <span className="peer-avatar">{avatar ? <img src={avatar} alt="" onError={() => setAvatar('')} /> : <span aria-hidden="true">{initials}</span>}</span>
      <div><strong dir="auto">{name || 'Pubky account'}</strong><span className="peer-verified"><ShieldCheck size={13} aria-hidden="true" />Verified Pubky account</span></div>
    </div>
    <button className="peer-identifier" title="Copy verified Pubky identifier" aria-label="Copy verified Pubky identifier" onClick={() => copy(identifier)}><span dir="ltr">{identifier}</span><Copy size={13} aria-hidden="true" /></button>
    {profileState === 'loading' && <p className="hint">Loading public profile…</p>}
    {profileState === 'unavailable' && <p className="hint">Public profile unavailable. Use the Pubky identifier to recognize this person.</p>}
    {follow === 'loading' ? <p className="hint">Checking whether you follow this person…</p>
      : follow === 'following' ? <p className="peer-followed">You follow this person.</p>
      : <p className="peer-follow-warning">{follow === 'not-following' ? 'You don’t follow this person.' : 'Could not check whether you follow this person.'}</p>}
  </div>
}
