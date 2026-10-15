// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useLayoutEffect } from 'react'
import { cleanup as cleanupReact, render } from '@testing-library/react'
import { editNote, initializeNote } from './crdt'
import { createSharedNote, joinSharedNote, SharedNoteDocument } from './shared-note'
import { EditorSelectionKeeper } from './editor-selection'

let frames: Map<number, FrameRequestCallback>, nextFrame: number
const cleanup: (() => void)[] = []
beforeEach(() => {
  frames = new Map(); nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => { cleanupReact(); cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.unstubAllGlobals() })
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
  it('anchors local input in its rendered snapshot while resolving against the newer live document', () => {
    const { alice, bob, element, keeper } = setup()
    const renderedBeforeInput = alice.note
    bob.edit({ content: `Unseen ${bob.note.content}` }); alice.applyPeerUpdate(bob.getUpdate())
    const edited = editNote(renderedBeforeInput, { content: `${renderedBeforeInput.content}!` })
    element.value = edited.content; element.setSelectionRange(edited.content.length, edited.content.length, 'forward')
    const source = new SharedNoteDocument(edited)
    const restore = keeper.capture(alice, source)!
    alice.mergeLocal(edited); source.destroy()
    restore(); element.value = alice.note.content; keeper.flush()
    expect(element.selectionStart).toBe(alice.note.content.length)
    expect(element.selectionDirection).toBe('forward')
    expect(frames.size).toBe(0)
  })

  it('restores inside the React value commit before a following input task, without waiting for an animation frame', () => {
    const { alice, bob, state, keeper } = setup()
    function Editor({ value }: { value: string }) {
      useLayoutEffect(() => { keeper.flush() }, [value])
      return createElement('textarea', { value, readOnly: true, ref: (element: HTMLTextAreaElement | null) => { if (element) state.content = element } })
    }
    const view = render(createElement(Editor, { value: alice.note.content }))
    const editor = state.content
    editor.focus(); editor.setSelectionRange(0, 0)
    const restore = keeper.capture(alice)!
    bob.edit({ content: `${bob.note.content}\nBob` }); alice.applyPeerUpdate(bob.getUpdate())
    restore()
    expect(frames.size).toBe(1)
    view.rerender(createElement(Editor, { value: alice.note.content }))
    // React just changed the controlled value. The next native input must use
    // the restored start position even though no browser frame has run yet.
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([0, 0])
    expect(frames.size).toBe(0)
    keeper.invalidate()
    const next = editor.value.slice(0, editor.selectionStart) + 'Alice\n' + editor.value.slice(editor.selectionEnd)
    expect(next).toBe(`Alice\n${bob.note.content}`)
  })

  it('guards changed-text notebook refreshes against newer input and preserves selection direction', () => {
    const { element, keeper } = setup()
    const restore = keeper.captureOffsets()!
    element.value = `Changed ${element.value}`
    restore(); keeper.flush()
    expect([element.selectionStart, element.selectionEnd, element.selectionDirection]).toEqual([6, 10, 'backward'])
    const stale = keeper.captureOffsets()!
    element.value = `${element.value}!`
    stale(); keeper.invalidate(); element.setSelectionRange(element.value.length, element.value.length)
    flushFrames()
    expect(element.selectionStart).toBe(element.value.length)
  })

  it('retains a pending relative anchor when a notebook refresh also requests restoration', () => {
    const { alice, element, keeper, change } = setup()
    const remoteRestore = keeper.capture(alice)!
    change('Prefix '); remoteRestore()
    const notebookRestore = keeper.captureOffsets()!
    notebookRestore(); keeper.flush(); flushFrames()
    expect([element.selectionStart, element.selectionEnd, element.selectionDirection]).toEqual([13, 17, 'backward'])
  })

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
