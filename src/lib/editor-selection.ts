import type { SharedNoteDocument, SharedSelection } from './shared-note'

interface Options {
  scope(): string
  activeId(): string | undefined
  content(): HTMLTextAreaElement | null
  title(): HTMLInputElement | null
}
interface PendingSelection {
  doc: SharedNoteDocument
  element: HTMLTextAreaElement | HTMLInputElement
  scope: string
  id: string
  epoch: number
  ticket: number
  selection: SharedSelection
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

  capture(doc: SharedNoteDocument): (() => void) | undefined {
    const focused = document.activeElement
    const field = focused && focused === this.options.content() ? 'content' : focused && focused === this.options.title() ? 'title' : undefined
    const element = field === 'content' ? this.options.content() : field === 'title' ? this.options.title() : null
    let id: string
    try { id = doc.descriptor.id } catch { this.invalidate(); return }
    if (!element || !field || this.options.activeId() !== id) { this.invalidate(); return }
    const scope = this.options.scope()
    let pending = this.pending
    if (!pending || pending.epoch !== this.epoch || pending.doc !== doc || pending.element !== element || pending.scope !== scope || pending.id !== id) {
      pending = { doc, element, scope, id, epoch: this.epoch, ticket: 0,
        selection: doc.captureSelection(field, element.selectionStart ?? 0, element.selectionEnd ?? 0), direction: element.selectionDirection ?? 'none' }
      this.pending = pending
    }
    // Reuse the relative anchor when another peer change arrives before the
    // browser has restored the DOM selection from the preceding change.
    const ticket = ++this.ticket
    pending.ticket = ticket
    const captured = pending
    return () => {
      if (!this.current(captured, ticket)) return
      if (this.frame !== undefined) cancelAnimationFrame(this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = undefined
        if (!this.current(captured, ticket)) return
        try {
          // Resolve against the latest live document, including changes made
          // while persistence or the animation frame was pending.
          const selection = captured.doc.resolveSelection(captured.selection)
          if (selection) captured.element.setSelectionRange(Math.min(selection.start, selection.end), Math.max(selection.start, selection.end), captured.direction)
        } catch { /* A room can close while this animation frame is pending. */ }
        finally { if (this.pending === captured) this.pending = undefined }
      })
    }
  }

  private current(pending: PendingSelection, ticket: number): boolean {
    return this.pending === pending && pending.epoch === this.epoch && pending.ticket === ticket &&
      this.options.scope() === pending.scope && this.options.activeId() === pending.id && document.activeElement === pending.element &&
      (pending.selection.field === 'content' ? this.options.content() : this.options.title()) === pending.element
  }
}
