import { useEffect, useState } from 'react'
import { Copy, LogOut } from 'lucide-react'
import { loadAvatar, loadProfile } from '../lib/profile'

interface Props { owner: string; disabled: boolean; copy: (value: string) => Promise<void>; disconnect: () => void }

// Keying the inner component prevents a previous account flashing while effects reset.
export default function AccountProfile(props: Props) { return <Identity key={props.owner} {...props} /> }

function Identity({ owner, disabled, copy, disconnect }: Props) {
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    void (async () => {
      try {
        const profile = await loadProfile(owner, controller.signal)
        if (controller.signal.aborted) return
        setName(profile.name)
        if (profile.image) {
          const blob = await loadAvatar(profile.image, controller.signal)
          if (controller.signal.aborted) return
          objectUrl = URL.createObjectURL(blob)
          setAvatar(objectUrl)
        }
      } catch { /* Public profile availability must never block the notebook. */ }
    })()
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [owner])
  const identifier = `pubky${owner}`
  const initials = name ? name.split(/\s+/u).slice(0, 2).map(word => [...word][0]).join('').toUpperCase() : owner.slice(0, 2).toUpperCase()
  return <div className="account-row">
    <span className="avatar">{avatar ? <img src={avatar} alt="" onError={() => setAvatar('')} /> : <span aria-hidden="true">{initials}</span>}</span>
    <div className="account-identity">
      <strong dir="auto" title={name || 'Pubky account'}>{name || 'Pubky account'}</strong>
      <button className="account-identifier" title={identifier} aria-label="Copy Pubky identifier" onClick={() => void copy(identifier)}><span dir="ltr">{owner.slice(0, 5)}…{owner.slice(-4)}</span><Copy size={12} aria-hidden="true" /></button>
    </div>
    <button className="icon-button" onClick={disconnect} disabled={disabled} title="Disconnect" aria-label="Disconnect from Pubky"><LogOut size={16} /></button>
  </div>
}
