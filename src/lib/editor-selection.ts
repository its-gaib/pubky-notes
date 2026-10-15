import type { SharedNoteDocument, SharedSelection } from './shared-note'

interface Options {
  scope(): string
  activeId(): string | undefined
  content(): HTMLTextAreaElement | null
  title(): HTMLInputElement | null
}
interface PendingSelection {
  anchor: { doc: SharedNoteDocument; selection: SharedSelection } | { start: number; end: number; value: string }
  field: 'content' | 'title'
  element: HTMLTextAreaElement | HTMLInputElement
  scope: string
  id: string
  epoch: number
  ticket: number
  ready: boolean
  direction: 'forward' | 'backward' | 'none'
}

/** Keep the editor's local selection through remote changes without undoing newer user input. */
export class EditorSelectionKeeper {
  private epoch = 0
  private ticket = 0
  private pending?: PendingSelection
  private frame?: number

  constructor(private readonly options: Options) {}

  /** Call on editor interaction, navigation, and teardown; programmatic selection restoration is not input. */
  invalidate(): void {
    this.epoch++
    this.pending = undefined
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.frame = undefined
  }

  capture(doc: SharedNoteDocument, rendered = doc): (() => void) | undefined {
    const focused = document.activeElement
    const field = focused && focused === this.options.content() ? 'content' : focused && focused === this.options.title() ? 'title' : undefined
    const element = field === 'content' ? this.options.content() : field === 'title' ? this.options.title() : null
    let id: string
    try {
      const live = doc.descriptor, source = rendered.descriptor
      id = live.id
      if (source.id !== id || source.createdAt !== live.createdAt || source.lineage !== live.lineage) { this.invalidate(); return }
    } catch { this.invalidate(); return }
    if (!element || !field || this.options.activeId() !== id) { this.invalidate(); return }
    const scope = this.options.scope()
    let pending = this.pending
    if (rendered !== doc || !pending || pending.epoch !== this.epoch || !('doc' in pending.anchor) || pending.anchor.doc !== doc || pending.element !== element || pending.scope !== scope || pending.id !== id) {
      pending = { element, field, scope, id, epoch: this.epoch, ticket: 0, ready: false,
        anchor: { doc, selection: rendered.captureSelection(field, element.selectionStart ?? 0, element.selectionEnd ?? 0) }, direction: element.selectionDirection ?? 'none' }
      this.pending = pending
    }
    // Reuse the relative anchor when another peer change arrives before the
    // browser has restored the DOM selection from the preceding change.
    return this.prepare(pending)
  }

  /** Guard a normal notebook refresh, giving an existing relative anchor priority. */
  captureOffsets(value: string): (() => void) | undefined {
    if (this.pending && this.current(this.pending, this.pending.ticket)) {
      if (!('doc' in this.pending.anchor)) this.pending.anchor.value = value
      return this.prepare(this.pending)
    }
    const focused = document.activeElement
    const field = focused && focused === this.options.content() ? 'content' : focused && focused === this.options.title() ? 'title' : undefined
    const element = field === 'content' ? this.options.content() : field === 'title' ? this.options.title() : null
    const id = this.options.activeId()
    if (!element || !field || !id) return
    const pending: PendingSelection = { element, field, id, scope: this.options.scope(), epoch: this.epoch, ticket: 0, ready: false,
      anchor: { start: element.selectionStart ?? 0, end: element.selectionEnd ?? 0, value }, direction: element.selectionDirection ?? 'none' }
    this.pending = pending
    return this.prepare(pending)
  }

  /** Run in a layout effect after a controlled value commit, before another input task can run. */
  flush(): void {
    const pending = this.pending
    if (!pending?.ready || !this.current(pending, pending.ticket)) return
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.frame = undefined
    // A browser frame can run before React commits a concurrent value update.
    // Keep the anchor until its text is actually displayed; a later layout
    // effect will flush it without a polling loop or another scheduled frame.
    let value: string
    try { value = 'doc' in pending.anchor ? pending.anchor.doc.note[pending.field] : pending.anchor.value }
    catch { if (this.pending === pending) this.pending = undefined; return }
    if (pending.element.value !== value) return
    try {
      const selection = 'doc' in pending.anchor ? pending.anchor.doc.resolveSelection(pending.anchor.selection) : pending.anchor
      if (selection) pending.element.setSelectionRange(Math.min(selection.start, selection.end), Math.max(selection.start, selection.end), pending.direction)
    } catch { /* A room can close while restoration is pending. */ }
    finally { if (this.pending === pending) this.pending = undefined }
  }

  private prepare(pending: PendingSelection): () => void {
    const ticket = ++this.ticket
    pending.ticket = ticket
    pending.ready = false
    const captured = pending
    return () => {
      if (!this.current(captured, ticket)) return
      captured.ready = true
      if (this.frame !== undefined) cancelAnimationFrame(this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = undefined
        if (!this.current(captured, ticket)) return
        this.flush()
      })
    }
  }

  private current(pending: PendingSelection, ticket: number): boolean {
    return this.pending === pending && pending.epoch === this.epoch && pending.ticket === ticket &&
      this.options.scope() === pending.scope && this.options.activeId() === pending.id && document.activeElement === pending.element &&
      (pending.field === 'content' ? this.options.content() : this.options.title()) === pending.element
  }
}
