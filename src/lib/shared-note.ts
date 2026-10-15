import * as Y from 'yjs'
import {
  decode, editPersonal, editText, encode, LineageConflictError, materializeSharedNote, mergeNotes, newPersonalDocument,
  personalDocumentOf, sharedDocumentOf, validateCrdtNote, validateFields, validateSharedUpdate,
} from './crdt'
import type { CrdtNote, NotePatch } from './crdt'

export interface SharedNoteDescriptor { id: string; createdAt: string; lineage: string }
export interface SharedSelection { start: Y.RelativePosition; end: Y.RelativePosition; field: 'title' | 'content' }

/** Fork visible text once. Old private operations never enter the collaboration. */
export function createSharedNote(source: CrdtNote): CrdtNote {
  const clean = validateCrdtNote(source)
  const now = new Date().toISOString()
  const doc = new Y.Doc({ gc: false }), personal = newPersonalDocument(clean.folder)
  doc.clientID = 0
  try {
    doc.transact(() => { doc.getText('title').insert(0, clean.title); doc.getText('content').insert(0, clean.content) })
    return materializeSharedNote(doc, personal, { id: crypto.randomUUID(), title: clean.title, content: clean.content, createdAt: now, updatedAt: now }, `shared:${crypto.randomUUID()}`)
  } finally { doc.destroy(); personal.destroy() }
}

export function sharedNoteDescriptor(note: CrdtNote): SharedNoteDescriptor {
  const clean = validateCrdtNote(note)
  if (clean.crdt?.version !== 2) throw new Error('This note is not a shared document.')
  return { id: clean.id, createdAt: clean.createdAt, lineage: clean.crdt.lineage }
}

export function joinSharedNote(descriptor: SharedNoteDescriptor, update: Uint8Array): CrdtNote {
  if (typeof descriptor !== 'object' || descriptor === null) throw new Error('Invalid shared document invitation.')
  validateSharedUpdate(update)
  const doc = new Y.Doc({ gc: false }), personal = newPersonalDocument()
  try {
    Y.applyUpdate(doc, update)
    // Joining requires a self-contained checkpoint, not unresolved operations whose base is missing.
    if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('The shared document checkpoint is incomplete.')
    return materializeSharedNote(doc, personal, { id: descriptor.id, title: '', content: '', createdAt: descriptor.createdAt, updatedAt: new Date().toISOString() }, descriptor.lineage)
  } finally { doc.destroy(); personal.destroy() }
}

/** The authoritative, long-lived document used by the editor and the peer transport. */
export class SharedNoteDocument {
  private readonly doc: Y.Doc
  private readonly personal: Y.Doc
  private current: CrdtNote
  private destroyed = false

  constructor(note: CrdtNote) {
    const clean = validateCrdtNote(note)
    if (clean.crdt?.version !== 2) throw new Error('This note is not a shared document.')
    this.doc = sharedDocumentOf(clean)
    this.personal = personalDocumentOf(clean)
    this.current = clean
  }

  get note(): CrdtNote { this.assertAlive(); return { ...this.current, crdt: { ...this.current.crdt! } } }
  get descriptor(): SharedNoteDescriptor { this.assertAlive(); return sharedNoteDescriptor(this.current) }

  edit(patch: NotePatch): CrdtNote {
    this.assertAlive()
    const requested = validateFields({ ...this.current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() })
    // Stage the same operations with the same client IDs before touching either live document.
    const candidate = sharedDocumentOf(this.current), personal = personalDocumentOf(this.current)
    candidate.clientID = this.doc.clientID
    personal.clientID = this.personal.clientID
    try {
      candidate.transact(() => { editText(candidate.getText('title'), requested.title); editText(candidate.getText('content'), requested.content) })
      editPersonal(personal, this.current, requested)
      const next = materializeSharedNote(candidate, personal, requested, this.current.crdt!.lineage)
      this.doc.transact(() => { editText(this.doc.getText('title'), requested.title); editText(this.doc.getText('content'), requested.content) })
      editPersonal(this.personal, this.current, requested)
      this.current = next
      return this.note
    } finally { candidate.destroy(); personal.destroy() }
  }

  mergeLocal(note: CrdtNote): CrdtNote {
    this.assertAlive()
    // This is exclusively for the caller's own local/homeserver replica, never another account's JSON.
    return this.commitOwn(mergeNotes(this.current, note))
  }

  getStateVector(): Uint8Array { this.assertAlive(); return Y.encodeStateVector(this.doc) }

  getUpdate(vector?: Uint8Array): Uint8Array {
    this.assertAlive()
    if (vector !== undefined) {
      if (!(vector instanceof Uint8Array) || vector.byteLength > 256 * 1024) throw new Error('Invalid shared state vector.')
      Y.decodeStateVector(vector)
    }
    return Y.encodeStateAsUpdate(this.doc, vector)
  }

  applyPeerUpdate(bytes: Uint8Array): CrdtNote {
    this.assertAlive()
    validateSharedUpdate(bytes)
    const candidate = sharedDocumentOf(this.current)
    try {
      Y.applyUpdate(candidate, bytes)
      const update = encode(Y.encodeStateAsUpdate(candidate))
      if (update === this.current.crdt!.update) return this.note
      const next = materializeSharedNote(candidate, this.personal, { ...this.current, updatedAt: new Date().toISOString() }, this.current.crdt!.lineage)
      Y.applyUpdate(this.doc, bytes)
      this.current = next
      return this.note
    } finally { candidate.destroy() }
  }

  captureSelection(field: 'title' | 'content', start: number, end = start): SharedSelection {
    this.assertAlive()
    const text = this.doc.getText(field)
    const clamp = (index: number) => Math.max(0, Math.min(text.length, Number.isFinite(index) ? Math.floor(index) : 0))
    return { field, start: Y.createRelativePositionFromTypeIndex(text, clamp(start)), end: Y.createRelativePositionFromTypeIndex(text, clamp(end)) }
  }

  resolveSelection(selection: SharedSelection): { start: number; end: number } | null {
    this.assertAlive()
    // Relative positions may arrive from a peer. Never let a forged root name
    // cause Yjs to create another shared type while merely resolving a cursor.
    if (!selection || !['title', 'content'].includes(selection.field)) return null
    const validPosition = (position: Y.RelativePosition) => position && position.type === null && position.tname === selection.field
      && [-1, 0, 1].includes(position.assoc) && (position.item === null || (Number.isSafeInteger(position.item.client) && position.item.client >= 0 && position.item.client <= 0xffffffff && Number.isSafeInteger(position.item.clock) && position.item.clock >= 0))
    if (!validPosition(selection.start) || !validPosition(selection.end)) return null
    const text = this.doc.share.get(selection.field)
    if (!(text instanceof Y.Text)) return null
    const start = Y.createAbsolutePositionFromRelativePosition(selection.start, this.doc)
    const end = Y.createAbsolutePositionFromRelativePosition(selection.end, this.doc)
    return start?.type === text && end?.type === text ? { start: start.index, end: end.index } : null
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.doc.destroy(); this.personal.destroy()
  }

  private commitOwn(note: CrdtNote): CrdtNote {
    if (note.crdt?.version !== 2 || note.id !== this.current.id || note.createdAt !== this.current.createdAt || note.crdt.lineage !== this.current.crdt!.lineage) throw new LineageConflictError()
    Y.applyUpdate(this.doc, decode(note.crdt.update))
    Y.applyUpdate(this.personal, decode(note.crdt.personal))
    this.current = note
    return this.note
  }

  private assertAlive(): void { if (this.destroyed) throw new Error('This shared document has been closed.') }
}
