import type { Capabilities } from '@synonymdev/pubky'

export const APP_CLIENT_ID = 'notes.pubky.app'
export const APP_PATHS = {
  private: '/priv/notes/',
  public: '/pub/notes/',
} as const
// Keep legacy scopes only to move existing data and clean up old public copies.
export const LEGACY_PATHS = {
  private: `/priv/${APP_CLIENT_ID}/notes/`,
  public: `/pub/${APP_CLIENT_ID}/notes/`,
} as const
export const APP_CAPABILITIES =
  `${APP_PATHS.private}:rw,${APP_PATHS.public}:rw,${LEGACY_PATHS.private}:rw,${LEGACY_PATHS.public}:rw` as Capabilities

// Hosted builds use the public network. Local testnet is an explicit opt-in.
export const IS_TESTNET = import.meta.env.VITE_PUBKY_TESTNET === 'true'
export const TESTNET_HOST = import.meta.env.VITE_PUBKY_TESTNET_HOST || undefined
export const HTTP_RELAY =
  import.meta.env.VITE_PUBKY_HTTP_RELAY?.trim() ||
  (IS_TESTNET ? `http://${TESTNET_HOST ?? 'localhost'}:15412/inbox/` : undefined)
