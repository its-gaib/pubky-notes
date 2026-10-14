import { useCallback, useEffect, useRef, useState } from 'react'
import type { CrdtNote, NotePatch } from '../lib/crdt'
import { editNote } from '../lib/crdt'
import { createSharedNote, joinSharedNote, SharedNoteDocument, sharedNoteDescriptor } from '../lib/shared-note'
import {
  createGuestRoom, createHostRoom, fingerprint, invitationUrl, loadRoom, parseInvitation, startCollaboration,
} from '../lib/collaboration'
import type { CollaborationStatus, CollaborationTransport, Invitation, JoinRequest, StoredRoom } from '../lib/collaboration'

interface Options {
  scope: string
  enabled: boolean
  notes: CrdtNote[]
  activeId?: string
  persist(note: CrdtNote, scope: string, select?: boolean): Promise<void>
  beforeRemoteChange(doc: SharedNoteDocument): (() => void) | undefined
}
interface LiveRoom {
  room: StoredRoom
  doc?: SharedNoteDocument
  transport?: CollaborationTransport
  connected: boolean
  alive: boolean
  syncTimer?: ReturnType<typeof setInterval>
  persistedUpdate?: string
}
export interface CollaborationView {
  noteId?: string
  role?: 'host' | 'guest'
  status?: CollaborationStatus
  request?: JoinRequest
  link?: string
  error?: string
  ownFingerprint?: string
  peerReceived: boolean
  working: boolean
}

const initial: CollaborationView = { peerReceived: false, working: false }
const encoder = new TextEncoder()
function packet(type: number, bytes: Uint8Array = new Uint8Array()): Uint8Array {
  const result = new Uint8Array(bytes.length + 1); result[0] = type; result.set(bytes, 1); return result
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')
}

/** One active collaboration per tab. All delayed work is bound to its original account. */
export function useCollaboration(options: Options) {
  const latest = useRef(options); latest.current = options
  const live = useRef<LiveRoom | null>(null)
  const generation = useRef(0)
  const paused = useRef('')
  const [view, setView] = useState<CollaborationView>(initial)
  const [invitation, setInvitation] = useState<Invitation | null>(() => {
    try { return parseInvitation(window.location.hash) } catch { return null }
  })
  useEffect(() => {
    function consumeInvitation() {
      if (!new URLSearchParams(window.location.hash.slice(1)).has('collaborate')) return
      try { setInvitation(parseInvitation(window.location.hash)) }
      catch { setView(previous => ({ ...previous, error: 'This collaboration invitation is invalid.' })) }
      finally {
        // Hash navigation can open an invitation in an already-mounted notebook.
        // Never retain the bearer secret in the address bar after consuming it.
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      }
    }
    consumeInvitation()
    window.addEventListener('hashchange', consumeInvitation)
    return () => window.removeEventListener('hashchange', consumeInvitation)
  }, [])
  const current = useCallback((connection: LiveRoom) => connection.alive && live.current === connection &&
    latest.current.enabled && latest.current.scope === connection.room.scope, [])
  const stop = useCallback(() => {
    generation.current++
    const connection = live.current
    live.current = null
    if (connection) {
      paused.current = `${connection.room.scope}:${connection.room.descriptor.id}`
      connection.alive = false; clearInterval(connection.syncTimer); connection.transport?.dispose(); connection.doc?.destroy()
    }
    setView(initial)
  }, [])
  useEffect(() => { stop(); paused.current = ''; return stop }, [options.scope, options.enabled, stop])

  const attach = useCallback((room: StoredRoom, note?: CrdtNote) => {
    stop()
    paused.current = ''
    const connection: LiveRoom = { room, doc: note ? new SharedNoteDocument(note) : undefined, connected: false, alive: true }
    live.current = connection
    setView({ ...initial, noteId: room.descriptor.id, role: room.role,
      link: room.role === 'host' ? invitationUrl(room, window.location.origin) : undefined })
    void fingerprint(room.identity.publicKey).then(ownFingerprint => {
      if (current(connection)) setView(previous => ({ ...previous, ownFingerprint }))
    }).catch(() => undefined)
    const send = async (message: Uint8Array) => {
      if (current(connection) && connection.connected) await connection.transport!.send(message)
    }
    connection.transport = startCollaboration(room, {
      onStatus(status) {
        if (!current(connection)) return
        const wasConnected = connection.connected
        connection.connected = status.state === 'connected'
        setView(previous => ({ ...previous, status, ...(connection.connected ? { request: undefined, error: undefined } : { peerReceived: false }) }))
        if (connection.connected && !wasConnected) {
          void send(packet(0, connection.doc?.getStateVector())).catch(error => {
            if (current(connection)) setView(previous => ({ ...previous, error: error.message }))
          })
        }
      },
      onRequest(request) { if (current(connection)) setView(previous => ({ ...previous, request })) },
      onError(error) { if (current(connection)) setView(previous => ({ ...previous, error: error.message })) },
      async onMessage(message) {
        if (!current(connection)) return
        if (!message.length) throw new Error('Invalid collaboration message.')
        const type = message[0], payload = message.subarray(1)
        if (type === 0) {
          if (connection.doc) await send(packet(1, connection.doc.getUpdate(payload.length ? payload : undefined)))
        } else if (type === 1) {
          const first = !connection.doc
          const restoreSelection = connection.doc ? latest.current.beforeRemoteChange(connection.doc) : undefined
          if (!connection.doc) connection.doc = new SharedNoteDocument(joinSharedNote(room.descriptor, payload))
          else connection.doc.applyPeerUpdate(payload)
          if (!current(connection)) return
          const next = connection.doc.note
          const receivedHash = await digest(connection.doc.getUpdate())
          if (!current(connection)) return
          // A duplicate can follow a failed local write. Only skip snapshots
          // that this connection has already durably persisted.
          if (connection.persistedUpdate !== next.crdt!.update) {
            const saving = latest.current.persist(next, room.scope, first)
            restoreSelection?.()
            await saving
            connection.persistedUpdate = next.crdt!.update
          }
          if (!current(connection)) return
          // This acknowledges device persistence, not the other person's homeserver.
          await send(packet(2, encoder.encode(receivedHash)))
          if (first) await send(packet(0, connection.doc.getStateVector()))
        } else if (type === 2) {
          if (payload.length !== 64 || !connection.doc) throw new Error('Invalid collaboration acknowledgement.')
          const acknowledged = new TextDecoder().decode(payload)
          const expected = await digest(connection.doc.getUpdate())
          if (current(connection) && acknowledged === expected) setView(previous => ({ ...previous, peerReceived: true }))
        } else throw new Error('Unsupported collaboration message.')
      },
    })
    // Reconcile periodically as well as on open. This repairs startup event
    // races and temporary send backpressure without requiring a page reload.
    connection.syncTimer = setInterval(() => {
      if (current(connection) && connection.connected) {
        void send(packet(0, connection.doc?.getStateVector())).catch(error => {
          if (current(connection)) setView(previous => ({ ...previous, error: error.message }))
        })
      }
    }, 5_000)
  }, [stop, current])

  const sendDifference = useCallback((connection: LiveRoom, before: Uint8Array) => {
    if (!current(connection) || !connection.doc) return
    setView(previous => ({ ...previous, peerReceived: false }))
    if (connection.connected) void connection.transport!.send(packet(1, connection.doc.getUpdate(before))).catch(error => {
      if (current(connection)) setView(previous => ({ ...previous, error: error.message }))
    })
  }, [current])

  useEffect(() => {
    const connection = live.current
    if (!connection || !current(connection) || !connection.doc) return
    const note = options.notes.find(note => note.id === connection.room.descriptor.id)
    if (!note) return
    if (note.deleted) { stop(); return }
    try {
      const before = connection.doc.getStateVector(), previous = connection.doc.note.crdt!.update
      connection.doc.mergeLocal(note)
      if (previous !== connection.doc.note.crdt!.update) sendDifference(connection, before)
    } catch (error) {
      stop(); setView({ ...initial, error: error instanceof Error ? error.message : 'Collaboration could not resume.' })
    }
  }, [options.notes, current, sendDifference, stop])

  useEffect(() => {
    if (!options.enabled || live.current || invitation) return
    const note = options.notes.find(note => note.id === options.activeId)
    if (note?.crdt?.version !== 2 || note.deleted || paused.current === `${options.scope}:${note.id}`) return
    const epoch = generation.current
    let canceled = false
    void loadRoom(options.scope, note.id).then(room => {
      if (!canceled && epoch === generation.current && room && !live.current && latest.current.enabled && latest.current.scope === room.scope) attach(room, note)
    }).catch(error => { if (!canceled) setView(previous => ({ ...previous, error: error.message })) })
    return () => { canceled = true }
  }, [options.enabled, options.scope, options.activeId, options.notes, invitation, attach])

  async function start(note: CrdtNote) {
    if (!latest.current.enabled) throw new Error('Connect Pubky before collaborating.')
    const scope = latest.current.scope, epoch = generation.current
    setView(previous => ({ ...previous, working: true, error: undefined }))
    try {
      const shared = note.crdt?.version === 2 ? note : createSharedNote(note)
      const existing = await loadRoom(scope, shared.id)
      const room = existing ?? await createHostRoom(scope, sharedNoteDescriptor(shared))
      if (scope !== latest.current.scope || !latest.current.enabled || epoch !== generation.current) return
      await latest.current.persist(shared, scope, true)
      if (scope !== latest.current.scope || !latest.current.enabled || epoch !== generation.current) return
      attach(room, shared)
    } finally { if (scope === latest.current.scope) setView(previous => ({ ...previous, working: false })) }
  }
  async function join() {
    if (!invitation || !latest.current.enabled) return
    const scope = latest.current.scope, epoch = generation.current
    setView(previous => ({ ...previous, working: true, error: undefined }))
    try {
      const existing = latest.current.notes.find(note => note.id === invitation.descriptor.id)
      if (existing && (existing.crdt?.version !== 2 || existing.crdt.lineage !== invitation.descriptor.lineage || existing.createdAt !== invitation.descriptor.createdAt)) {
        throw new Error('This invitation conflicts with another note. Your existing note was retained.')
      }
      if (existing?.deleted) throw new Error('Restore your copy from Trash before joining again.')
      const stored = await loadRoom(scope, invitation.descriptor.id)
      const room = stored?.room === invitation.room && stored.hostKey === invitation.hostKey && stored.secret === invitation.secret
        ? stored : await createGuestRoom(scope, invitation)
      if (scope !== latest.current.scope || !latest.current.enabled || epoch !== generation.current) return
      attach(room, existing); setInvitation(null)
    } finally { if (scope === latest.current.scope) setView(previous => ({ ...previous, working: false })) }
  }
  function edit(note: CrdtNote, patch: NotePatch): CrdtNote {
    const connection = live.current
    if (!connection || !current(connection) || connection.doc?.note.id !== note.id) return editNote(note, patch)
    connection.doc.mergeLocal(note)
    const before = connection.doc.getStateVector(), previous = connection.doc.note.crdt!.update
    const next = connection.doc.edit(patch)
    if (previous !== next.crdt!.update) sendDifference(connection, before)
    return next
  }
  async function approve() {
    const connection = live.current, request = view.request
    if (!connection || !request || !current(connection)) return
    await connection.transport!.approve(request.peerId)
    if (current(connection)) setView(previous => ({ ...previous, request: undefined }))
  }
  function reject() {
    const connection = live.current
    if (connection && view.request && current(connection)) connection.transport?.reject(view.request.peerId)
    setView(previous => ({ ...previous, request: undefined }))
  }
  return { view, invitation, start, join, edit, approve, reject, stop,
    dismissInvitation: () => setInvitation(null), reconnect: () => live.current?.transport?.reconnect() }
}
