import * as Y from 'yjs'
import type { SharedNoteDocument, SharedSelection } from '../shared-note'

export const MAX_PRESENCE_BYTES = 2_048
export const PRESENCE_INTERVAL = 50
export const PRESENCE_STALE_AFTER = 15_000
const CAPABILITY = 'a=x-pubky-notes-presence:1'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const colors = ['#8b36c7', '#19768c', '#bb491c', '#3569c8', '#b02d72', '#417b27']

export interface EditorSelection { field: 'content'; start: number; end: number; direction?: 'forward' | 'backward' | 'none' }
export interface RemoteSelection extends EditorSelection { noteId: string; label: string; color: string }
interface Presence { selection: (SharedSelection & { field: 'content'; direction: 'forward' | 'backward' | 'none' }) | null; label: string }

/** Optional SDP attributes are ignored by older browsers/apps. Never send new packets without mutual support. */
export function advertisePresence(sdp: string): string { return `${sdp.trimEnd()}\r\n${CAPABILITY}\r\n` }
export function supportsPresence(sdp: string): boolean { return sdp.split(/\r?\n/).some(line => line === CAPABILITY) }

export function presenceLabel(value: unknown): string {
  return typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim()).slice(0, 64).join('') : ''
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function keys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every(key => allowed.includes(key)) }
function id(value: unknown): boolean {
  return object(value) && keys(value, ['client', 'clock']) && Number.isSafeInteger(value.client) && (value.client as number) >= 0 && (value.client as number) <= 0xffffffff && Number.isSafeInteger(value.clock) && (value.clock as number) >= 0
}
function position(value: unknown): Y.RelativePosition | null {
  if (!object(value) || !keys(value, ['type', 'tname', 'item', 'assoc']) || value.type != null || value.tname !== 'content' || (value.item != null && !id(value.item)) || ![-1, 0, 1].includes(value.assoc as number)) return null
  return Y.createRelativePositionFromJSON(value)
}
export function decodePresence(bytes: Uint8Array): Presence | undefined {
  // Check before decoding UTF-8 or parsing JSON, including for callers outside the transport.
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_PRESENCE_BYTES) return
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes))
    if (!object(value) || !keys(value, ['selection', 'label']) || typeof value.label !== 'string' || value.label.length > 256) return
    const label = presenceLabel(value.label)
    if (value.selection === null) return { selection: null, label }
    const selection = value.selection
    if (!object(selection) || !keys(selection, ['field', 'start', 'end', 'direction']) || selection.field !== 'content' || !['forward', 'backward', 'none'].includes(selection.direction as string)) return
    const start = position(selection.start), end = position(selection.end)
    if (!start || !end) return
    return { selection: { field: 'content', start, end, direction: selection.direction as 'forward' | 'backward' | 'none' }, label }
  } catch { return }
}
function encodePresence(value: Presence): Uint8Array { return encoder.encode(JSON.stringify(value)) }
function colorFor(fingerprint: string): string {
  let hash = 0
  for (const char of fingerprint) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0
  return colors[(hash >>> 0) % colors.length]
}

interface PresenceOptions {
  document(): SharedNoteDocument | undefined
  label(): string | undefined
  fingerprint(): string | undefined
  send(payload: Uint8Array): Promise<void>
  publish(selection: RemoteSelection | null): void
}

/** Cursor state is ephemeral: no document operations, storage, acknowledgement, or note timestamps. */
export class SelectionPresence {
  private connected = false
  private active = true
  private disposed = false
  private local: Presence['selection'] = null
  private remote?: Presence
  private outbound?: ReturnType<typeof setTimeout>
  private inbound?: ReturnType<typeof setTimeout>
  private stale?: ReturnType<typeof setTimeout>
  private incoming?: Uint8Array
  private inFlight = false
  private revision = 0
  private heartbeat: ReturnType<typeof setInterval>

  constructor(private readonly options: PresenceOptions) {
    this.heartbeat = setInterval(() => { if (this.local && this.active && this.connected) this.schedule() }, 5_000)
  }

  setConnected(connected: boolean): void {
    if (this.disposed || this.connected === connected) return
    this.connected = connected
    if (!connected) this.clear()
    else if (this.active && this.local) this.schedule()
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return
    this.active = active
    if (!active) { this.clear(); if (this.connected) this.schedule() }
  }

  update(selection: EditorSelection | null): void {
    if (this.disposed || !this.active || !this.connected) return
    const doc = this.options.document()
    this.local = selection && doc ? { ...doc.captureSelection('content', selection.start, selection.end), field: 'content', direction: selection.direction ?? 'none' } : null
    this.schedule()
  }

  receive(bytes: Uint8Array): void {
    if (this.disposed || !this.connected || !this.active || bytes.byteLength > MAX_PRESENCE_BYTES) return
    // Keep only the latest pending packet. A peer cannot accumulate parsing work or timers.
    this.incoming = new Uint8Array(bytes)
    if (this.inbound) return
    this.inbound = setTimeout(() => {
      this.inbound = undefined
      const bytes = this.incoming; this.incoming = undefined
      if (!bytes || this.disposed || !this.active || !this.connected) return
      const presence = decodePresence(bytes)
      if (!presence) return
      this.remote = presence
      clearTimeout(this.stale)
      this.stale = setTimeout(() => { this.remote = undefined; this.options.publish(null) }, PRESENCE_STALE_AFTER)
      this.refresh()
    }, PRESENCE_INTERVAL)
  }

  refresh(): void {
    if (this.disposed || !this.active || !this.connected || !this.remote?.selection) { this.options.publish(null); return }
    const doc = this.options.document(), selection = doc?.resolveSelection(this.remote.selection)
    if (!doc || !selection) { this.options.publish(null); return }
    const fingerprint = this.options.fingerprint() || ''
    this.options.publish({ noteId: doc.descriptor.id, field: 'content', start: Math.min(selection.start, selection.end), end: Math.max(selection.start, selection.end), direction: this.remote.selection.direction,
      label: this.remote.label || (fingerprint ? `Collaborator ${fingerprint}` : 'Collaborator'), color: colorFor(fingerprint) })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.heartbeat)
    this.clear()
  }

  private clear(): void {
    clearTimeout(this.outbound); clearTimeout(this.inbound); clearTimeout(this.stale)
    this.outbound = undefined; this.inbound = undefined; this.stale = undefined
    this.incoming = undefined; this.local = null; this.remote = undefined
    this.revision++
    this.options.publish(null)
  }

  private schedule(): void {
    this.revision++
    if (this.outbound || this.inFlight || this.disposed || !this.connected) return
    this.outbound = setTimeout(() => { this.outbound = undefined; void this.flush() }, PRESENCE_INTERVAL)
  }

  private async flush(): Promise<void> {
    if (this.disposed || !this.connected || this.inFlight) return
    const revision = this.revision
    this.inFlight = true
    try { await this.options.send(encodePresence({ selection: this.active ? this.local : null, label: presenceLabel(this.options.label()) })) }
    catch { /* Presence is best effort; document synchronization reports connection failures. */ }
    finally { this.inFlight = false; if (this.revision !== revision) this.schedule() }
  }
}
