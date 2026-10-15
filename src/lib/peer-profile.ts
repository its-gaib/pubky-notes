import { presenceLabel } from './collaboration/presence'
import { loadAvatar, loadProfile } from './profile'
import type { Profile } from './profile'

export { loadFollowRelationship } from './profile'
export type { FollowRelationship } from './profile'

/** The caller must establish the peer's Pubky identity before fetching their public profile. */
export async function loadPeerProfile(owner: string, signal?: AbortSignal): Promise<Profile> {
  const profile = await loadProfile(owner, signal)
  const name = presenceLabel(profile.name) || `Pubky ${owner.slice(0, 8)}`
  // Only expose owner-local references; loadPeerAvatar also validates the complete
  // path and any file-record hop before reading image bytes.
  const image = profile.image?.startsWith(`pubky://${owner}/pub/`) || profile.image?.startsWith(`pubky${owner}/pub/`)
    ? profile.image : undefined
  return { name, image }
}

/** Returns validated image bytes, never an external URL or a peer-provided data URI. */
export function loadPeerAvatar(owner: string, reference: string, signal?: AbortSignal): Promise<Blob> {
  return loadAvatar(reference, signal, owner)
}
