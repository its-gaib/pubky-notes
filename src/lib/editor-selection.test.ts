// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeNote } from './crdt'
import { createSharedNote, joinSharedNote, SharedNoteDocument } from './shared-note'
import { EditorSelectionKeeper } from './editor-selection'

let frames: Map<number, FrameRequestCallback>, nextFrame: number
const cleanup: (() => void)[] = []
beforeEach(() => {
  frames = new Map(); nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.unstubAllGlobals() })
function flushFrames() {
  const callbacks = [...frames.values()]; frames.clear()
  callbacks.forEach(callback => callback(0))
}
function setup(field: 'content' | 'title' = 'content') {
  const note = createSharedNote(initializeNote({ id: 'source', title: 'Meeting title', content: 'First line\nLast line', createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z' }))
  const alice = new SharedNoteDocument(note), bob = new SharedNoteDocument(joinSharedNote(alice.descriptor, alice.getUpdate()))
  const content = document.createElement('textarea'), title = document.createElement('input')
  content.value = note.content; title.value = note.title
  document.body.append(content, title)
  const element = field === 'content' ? content : title
  element.focus(); element.setSelectionRange(6, 10, 'backward')
  const state = { scope: 'alice', activeId: note.id, content, title }
  const keeper = new EditorSelectionKeeper({ scope: () => state.scope, activeId: () => state.activeId, content: () => state.content, title: () => state.title })
  const change = (prefix: string) => {
    bob.edit({ [field]: prefix + bob.note[field] })
    alice.applyPeerUpdate(bob.getUpdate())
    element.value = alice.note[field]
  }
  cleanup.push(() => { keeper.invalidate(); alice.destroy(); bob.destroy() })
  return { alice, bob, content, title, element, state, keeper, change }
}

describe('local editor selection restoration', () => {
  it.each(['content', 'title'] as const)('restores the %s selection after peer changes and preserves backwards selection direction', field => {
    const { alice, element, keeper, change } = setup(field)
    const restore = keeper.capture(alice)!
    change('Prefix ')
    restore()
    flushFrames()
    expect([element.selectionStart, element.selectionEnd, element.selectionDirection]).toEqual([13, 17, 'backward'])
  })

  it('does not overwrite Ctrl+End performed while the remote change is awaiting persistence', () => {
    const { alice, element, keeper, change } = setup()
    const restore = keeper.capture(alice)!
    change('Prefix ')
    // The caller invalidates synchronously on keydown, before the browser moves the caret.
    keeper.invalidate()
    element.setSelectionRange(element.value.length, element.value.length)
    restore(); flushFrames()
    expect(element.selectionStart).toBe(element.value.length)
    expect(frames.size).toBe(0)
  })

  it('cancels a scheduled restoration when typing and captures the new selection for the next peer change', () => {
    const { alice, bob, element, keeper, change } = setup()
    const oldRestore = keeper.capture(alice)!
    change('Prefix '); oldRestore()
    keeper.invalidate()
    alice.edit({ content: `${alice.note.content}!` })
    element.value = alice.note.content
    element.setSelectionRange(element.value.length, element.value.length, 'forward')
    flushFrames()
    expect(element.selectionStart).toBe(element.value.length)
    const nextRestore = keeper.capture(alice)!
    bob.applyPeerUpdate(alice.getUpdate())
    change('Next ')
    oldRestore(); nextRestore(); flushFrames()
    expect([element.selectionStart, element.selectionEnd, element.selectionDirection]).toEqual([element.value.length, element.value.length, 'forward'])
  })

  it('keeps one relative anchor across a burst instead of capturing stale DOM offsets and resolves at frame time', () => {
    const { alice, element, keeper, change } = setup()
    const firstRestore = keeper.capture(alice)!
    change('One '); firstRestore()
    // Replacing a textarea value moved its DOM selection to the end. It has
    // not yet received the restoration for the first peer update.
    expect(element.selectionStart).toBe(element.value.length)
    const secondRestore = keeper.capture(alice)!
    change('Two '); secondRestore()
    firstRestore() // An older delayed completion must not win.
    change('Three ') // A further replica update arrives before the browser frame.
    flushFrames()
    expect([element.selectionStart, element.selectionEnd, element.selectionDirection]).toEqual([20, 24, 'backward'])
    expect(frames.size).toBe(0)
  })

  it.each(['scope', 'note', 'focus', 'element', 'closed'] as const)('ignores pending callbacks after the %s changes', changeKind => {
    const { alice, element, title, state, keeper, change } = setup()
    const restore = keeper.capture(alice)!
    change('Prefix '); restore()
    const selection = [element.selectionStart, element.selectionEnd]
    if (changeKind === 'scope') state.scope = 'another-account'
    if (changeKind === 'note') state.activeId = 'another-note'
    if (changeKind === 'focus') title.focus()
    if (changeKind === 'element') state.content = document.createElement('textarea')
    if (changeKind === 'closed') alice.destroy()
    expect(() => flushFrames()).not.toThrow()
    expect([element.selectionStart, element.selectionEnd]).toEqual(selection)
  })

  it('does not capture a note that is not active or an unfocused editor', () => {
    const { alice, element, state, keeper } = setup()
    state.activeId = 'other'
    expect(keeper.capture(alice)).toBeUndefined()
    state.activeId = alice.descriptor.id; element.blur()
    expect(keeper.capture(alice)).toBeUndefined()
  })
})
