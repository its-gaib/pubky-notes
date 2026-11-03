import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import Markdown from './Markdown'
import { expandMulticharReferences, paragraphInsertion, plainOffsets, renderedOffsets } from '../lib/visual-markdown'

type Selection = { start: number; end: number }
export type VisualEditorHandle = { selection: () => Selection; select: (start: number, end?: number) => void; apply: (content: string, start: number, end?: number) => boolean; format: (before: string, after: string) => void }
type Props = { content: string; disabled: boolean; onChange: (content: string) => boolean; onSelection?: (selection: Selection | null) => void }
type Checkpoint = { content: string; selection: Selection }

function leaves(root: HTMLElement) { return [...(root.matches('[data-source-start]') ? [root] : []), ...root.querySelectorAll<HTMLElement>('[data-source-start]')] }
function map(element: HTMLElement, content: string) {
  const start = Number(element.dataset.sourceStart), end = Number(element.dataset.sourceEnd)
  const mapping = element.dataset.sourceKind === 'text' ? renderedOffsets : plainOffsets
  return mapping(content.slice(start, end), element.textContent ?? '').map(offset => offset + start)
}
function point(root: HTMLElement, content: string, node: Node, offset: number): number {
  const element = (node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement)?.closest<HTMLElement>('[data-source-start]')
  if (element && root.contains(element)) {
    const range = document.createRange(); range.selectNodeContents(element); range.setEnd(node, offset)
    const offsets = map(element, content)
    return offsets[Math.min(offsets.length - 1, range.toString().length)]
  }
  const range = document.createRange(); range.selectNodeContents(root); range.setEnd(node, offset)
  const previous = leaves(root).filter(leaf => range.intersectsNode(leaf)).at(-1)
  return previous ? Number(previous.dataset.sourceEnd) : 0
}
function readSelection(root: HTMLElement, content: string): Selection | undefined {
  const selection = window.getSelection()
  if (!selection?.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return
  const start = point(root, content, selection.anchorNode, selection.anchorOffset), end = point(root, content, selection.focusNode, selection.focusOffset)
  return { start: Math.min(start, end), end: Math.max(start, end) }
}
function domPoint(root: HTMLElement, content: string, offset: number): { node: Node; offset: number } {
  let best: { element: HTMLElement; index: number; distance: number } | undefined
  for (const element of leaves(root)) {
    const offsets = map(element, content)
    for (let index = 0; index < offsets.length; index++) {
      const distance = Math.abs(offsets[index] - offset)
      if (!best || distance < best.distance) best = { element, index, distance }
    }
    if (best?.distance === 0) break
  }
  if (!best) return { node: root, offset: 0 }
  const walker = document.createTreeWalker(best.element, NodeFilter.SHOW_TEXT)
  let index = best.index, node = walker.nextNode()
  while (node) {
    if (index <= (node.textContent?.length ?? 0)) return { node, offset: index }
    index -= node.textContent?.length ?? 0; node = walker.nextNode()
  }
  return { node: best.element, offset: 0 }
}
function restoreSelection(root: HTMLElement, content: string, selected: Selection) {
  const start = domPoint(root, content, selected.start), end = domPoint(root, content, selected.end)
  const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset)
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
}

/** Edits the canonical Markdown through its rendered leaf positions. The DOM
 * is never serialized and clipboard HTML never enters the note or renderer. */
const VisualEditor = forwardRef<VisualEditorHandle, Props>(function VisualEditor({ content, disabled, onChange, onSelection }, handle) {
  const root = useRef<HTMLDivElement>(null)
  const current = useRef({ content, disabled, onChange, onSelection })
  const remembered = useRef<Selection>({ start: content.length, end: content.length })
  const pending = useRef<Selection | undefined>(undefined)
  const undo = useRef<Checkpoint[]>([]), redo = useRef<Checkpoint[]>([])
  const composing = useRef<{ content: string; selection: Selection } | undefined>(undefined)
  const [generation, setGeneration] = useState(0)
  if (content !== current.current.content && !pending.current) {
    if (root.current && root.current.contains(document.activeElement) && !(document.activeElement instanceof HTMLTextAreaElement) && !(document.activeElement instanceof HTMLInputElement)) {
      const selected = readSelection(root.current, current.current.content)
      if (selected) {
        const offsets = plainOffsets(content, current.current.content)
        pending.current = { start: offsets[selected.start], end: offsets[selected.end] }
      }
    }
    // Undo is local to this rendered document. Never undo a remote edit by
    // restoring a stale document snapshot.
    undo.current = []; redo.current = []
  }
  current.current = { content, disabled, onChange, onSelection }

  function selection() { return (root.current && readSelection(root.current, current.current.content)) || remembered.current }
  function select(start: number, end = start) {
    remembered.current = { start, end }; pending.current = remembered.current
    root.current?.focus()
    if (root.current) restoreSelection(root.current, current.current.content, remembered.current)
    current.current.onSelection?.(remembered.current)
  }
  useImperativeHandle(handle, () => ({ selection, select,
    apply: (value, start, end = start) => commit(value, { start, end }),
    format: (before, after) => {
      const { start, end } = selection(), value = current.current.content
      // An empty `- ` directly after prose is a Setext heading underline,
      // not a list. Separate the blocks before placing the list caret.
      const prefix = before === '\n- ' && start > 0 && value[start - 1] !== '\n' ? '\n' + before : before
      const selected = value.slice(start, end) || (after ? before === '[' ? 'link' : 'text' : '')
      commit(value.slice(0, start) + prefix + selected + after + value.slice(end), { start: start + prefix.length, end: start + prefix.length + selected.length })
      root.current?.focus()
    },
  }))

  function commit(value: string, selected: Selection, history = true, restore = true) {
    const state = current.current
    if (state.disabled || value === state.content) return false
    if (history) {
      undo.current.push({ content: state.content, selection: selection() }); redo.current = []
      let total = 0
      for (let index = undo.current.length - 1; index >= 0; index--) {
        total += undo.current[index].content.length
        if (index < undo.current.length - 1 && (total > 2_000_000 || undo.current.length - index > 100)) { undo.current.splice(0, index + 1); break }
      }
    }
    pending.current = restore ? selected : undefined
    if (!state.onChange(value)) { pending.current = undefined; if (history) undo.current.pop(); return false }
    if (restore) remembered.current = selected
    return true
  }
  function replace(start: number, end: number, text: string, raw = false) {
    const value = current.current.content
    const native = window.getSelection(), range = native?.rangeCount ? native.getRangeAt(0) : undefined
    if (!raw && root.current && range) {
      if (range.startContainer === root.current && range.startOffset === 0 && range.endContainer === root.current && range.endOffset === root.current.childNodes.length && !range.collapsed) {
        commit(text, { start: text.length, end: text.length })
        return
      }
      const first = range.startContainer.parentElement?.closest<HTMLElement>('[data-source-start]')
      const last = range.endContainer.parentElement?.closest<HTMLElement>('[data-source-start]')
      if (first && first === last && first.dataset.sourceKind === 'text') {
        const from = Number(first.dataset.sourceStart), to = Number(first.dataset.sourceEnd)
        const expanded = expandMulticharReferences(value.slice(from, to))
        if (expanded !== value.slice(from, to)) {
          const prefix = document.createRange(); prefix.selectNodeContents(first); prefix.setEnd(range.startContainer, range.startOffset)
          const a = prefix.toString().length
          prefix.setEnd(range.endContainer, range.endOffset)
          const b = prefix.toString().length, offsets = renderedOffsets(expanded, first.textContent ?? '')
          const replacement = expanded.slice(0, offsets[a]) + text + expanded.slice(offsets[b])
          const caret = from + offsets[a] + text.length
          commit(value.slice(0, from) + replacement + value.slice(to), { start: caret, end: caret })
          return
        }
      }
    }
    if (!raw && root.current && start !== end) {
      // Delimiters between rendered leaves are invisible. Keep them paired
      // when a selection crosses formatting, rather than deleting half of a
      // bold span, code span or link along with its visible text.
      const ranges = leaves(root.current).map(leaf => ({ start: Number(leaf.dataset.sourceStart), end: Number(leaf.dataset.sourceEnd) }))
      const removed: Selection[] = ranges.map(range => ({ start: Math.max(start, range.start), end: Math.min(end, range.end) })).filter(range => range.start < range.end)
      for (let index = 1; index < ranges.length; index++) {
        const from = Math.max(start, ranges[index - 1].end), to = Math.min(end, ranges[index].start)
        if (from < to && /^\s*$/.test(value.slice(from, to))) removed.push({ start: from, end: to })
      }
      for (const format of root.current.querySelectorAll<HTMLElement>('[data-format-start]')) {
        const inside = leaves(format)
        const insertionInside = text && start >= Number(format.dataset.formatStart) && start < Number(format.dataset.formatEnd)
        if (!insertionInside && inside.length && inside.every(leaf => Number(leaf.dataset.sourceStart) >= start && Number(leaf.dataset.sourceEnd) <= end)) {
          removed.push({ start: Number(format.dataset.formatStart), end: Number(format.dataset.formatEnd) })
        }
      }
      if (removed.length) {
        removed.sort((a, b) => a.start - b.start)
        const merged: Selection[] = []
        for (const range of removed) {
          const previous = merged.at(-1)
          if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
          else merged.push({ ...range })
        }
        const insertion = merged[0].start
        let result = '', cursor = 0
        for (const range of merged) { result += value.slice(cursor, range.start) + (cursor === 0 ? text : ''); cursor = range.end }
        result += value.slice(cursor)
        commit(result, { start: insertion + text.length, end: insertion + text.length })
        return
      }
    }
    commit(value.slice(0, start) + text + value.slice(end), { start: start + text.length, end: start + text.length }, true, !(raw && document.activeElement instanceof HTMLTextAreaElement))
  }
  function history(backwards: boolean) {
    const from = backwards ? undo : redo, to = backwards ? redo : undo
    const checkpoint = from.current.pop()
    if (!checkpoint) return
    to.current.push({ content: current.current.content, selection: selection() })
    commit(checkpoint.content, checkpoint.selection, false)
  }
  function remove(backwards: boolean, word = false) {
    let { start, end } = selection()
    if (start === end && root.current && window.getSelection()?.isCollapsed) {
      // Native selection movement understands graphemes, emoji and words.
      const native = window.getSelection() as (globalThis.Selection & { modify?: (alter: string, direction: string, granularity: string) => void }) | null
      native?.modify?.('extend', backwards ? 'backward' : 'forward', word ? 'word' : 'character')
      const expanded = readSelection(root.current, current.current.content)
      if (expanded) { start = expanded.start; end = expanded.end }
    }
    if (start !== end || !window.getSelection()?.isCollapsed) replace(start, end, '')
  }

  useLayoutEffect(() => {
    if (root.current && pending.current && !composing.current) {
      restoreSelection(root.current, content, pending.current)
      current.current.onSelection?.(pending.current)
      pending.current = undefined
    }
  }, [content, generation])

  useEffect(() => {
    const element = root.current!
    function nested(event: Event) { return event.target instanceof Element && !!event.target.closest('textarea, input, [contenteditable="false"]') }
    function beforeInput(event: InputEvent) {
      if (nested(event) || composing.current || event.isComposing) return
      event.preventDefault()
      if (current.current.disabled) return
      const selected = selection()
      if (event.inputType === 'historyUndo') history(true)
      else if (event.inputType === 'historyRedo') history(false)
      else if (event.inputType.startsWith('delete')) remove(event.inputType.endsWith('Backward'), event.inputType.includes('Word'))
      else if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        const cell = window.getSelection()?.anchorNode?.parentElement?.closest('td, th')
        if (cell && event.inputType === 'insertParagraph') {
          const cells = [...element.querySelectorAll('td, th')], next = cells[cells.indexOf(cell) + 1]
          const leaf = next?.querySelector<HTMLElement>('[data-source-start]')
          if (leaf) select(Number(leaf.dataset.sourceStart))
        } else {
          const code = window.getSelection()?.anchorNode?.parentElement?.closest('pre')
          const lineStart = current.current.content.lastIndexOf('\n', selected.start - 1) + 1
          const line = current.current.content.slice(lineStart, selected.start)
          if (!code && event.inputType === 'insertParagraph' && /^\s*(?:[-+*]|\d+[.)]) (?:\[[ xX]\] )?$/.test(line)) replace(lineStart, selected.end, '\n', true)
          else replace(selected.start, selected.end, code ? '\n' : event.inputType === 'insertLineBreak' ? '  \n' : paragraphInsertion(current.current.content, selected.start))
        }
      } else if (event.inputType.startsWith('insert') && event.data !== null) replace(selected.start, selected.end, event.data)
    }
    function keydown(event: KeyboardEvent) {
      if (nested(event) || event.isComposing) return
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key.toLowerCase() === 'a') {
          event.preventDefault()
          const range = document.createRange(); range.selectNodeContents(element)
          const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
        } else if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') {
          event.preventDefault(); history(event.key.toLowerCase() === 'z' && !event.shiftKey)
        } else if (['b', 'i', 'k'].includes(event.key.toLowerCase())) {
          event.preventDefault()
          const selected = selection(), text = current.current.content.slice(selected.start, selected.end) || 'text'
          const marker = event.key.toLowerCase() === 'b' ? '**' : event.key.toLowerCase() === 'i' ? '_' : '['
          const after = marker === '[' ? '](https://)' : marker
          replace(selected.start, selected.end, marker + text + after)
          pending.current = { start: selected.start + marker.length, end: selected.start + marker.length + text.length }
        }
      }
    }
    function paste(event: ClipboardEvent) {
      if (nested(event)) return
      event.preventDefault()
      const selected = selection(); replace(selected.start, selected.end, event.clipboardData?.getData('text/plain').replace(/\r\n?/g, '\n') ?? '')
    }
    function cut(event: ClipboardEvent) {
      if (nested(event)) return
      event.preventDefault()
      const selected = selection()
      event.clipboardData?.setData('text/plain', window.getSelection()?.toString() ?? '')
      replace(selected.start, selected.end, '')
    }
    function drop(event: DragEvent) {
      if (nested(event)) return
      event.preventDefault() // Native HTML drops must never mutate this DOM.
      const range = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range }).caretRangeFromPoint?.(event.clientX, event.clientY)
      if (range && element.contains(range.startContainer)) {
        const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range)
      }
      const selected = selection(); replace(selected.start, selected.end, event.dataTransfer?.getData('text/plain') ?? '')
    }
    function compositionStart(event: CompositionEvent) {
      if (!nested(event)) composing.current = { content: current.current.content, selection: selection() }
    }
    function compositionEnd(event: CompositionEvent) {
      const started = composing.current
      if (!started || nested(event)) return
      composing.current = undefined
      const offsets = plainOffsets(current.current.content, started.content)
      replace(offsets[started.selection.start], offsets[started.selection.end], event.data)
      setGeneration(value => value + 1) // Remove browser-owned composition DOM.
    }
    function changed() {
      if (!element.contains(document.activeElement) || composing.current) return
      const selected = readSelection(element, current.current.content)
      if (selected) { remembered.current = selected; current.current.onSelection?.(selected) }
    }
    function blur(event: FocusEvent) { if (!element.contains(event.relatedTarget as Node | null)) current.current.onSelection?.(null) }
    element.addEventListener('beforeinput', beforeInput)
    element.addEventListener('keydown', keydown)
    element.addEventListener('paste', paste); element.addEventListener('cut', cut); element.addEventListener('drop', drop)
    element.addEventListener('compositionstart', compositionStart); element.addEventListener('compositionend', compositionEnd)
    element.addEventListener('focusout', blur); document.addEventListener('selectionchange', changed)
    return () => {
      element.removeEventListener('beforeinput', beforeInput); element.removeEventListener('keydown', keydown)
      element.removeEventListener('paste', paste); element.removeEventListener('cut', cut); element.removeEventListener('drop', drop)
      element.removeEventListener('compositionstart', compositionStart); element.removeEventListener('compositionend', compositionEnd)
      element.removeEventListener('focusout', blur); document.removeEventListener('selectionchange', changed)
    }
  }, [])

  return <div ref={root} className="visual-editor" role="textbox" aria-label="Visual content" aria-multiline="true" aria-readonly={disabled} contentEditable={!disabled} suppressContentEditableWarning spellCheck>
    {content ? <><Markdown key={generation} content={content} editing={{ source: content, disabled, replace: (start, end, text) => replace(start, end, text, true) }} />{(content.endsWith('\n') || /\n[ \t]*\n[ \t]*$/.test(content) || /^\s+$/.test(content)) && <p><span data-source-start={content.length} data-source-end={content.length}>{'\u200b'}</span></p>}</> : <p className="visual-placeholder"><span data-source-start="0" data-source-end="0">{'\u200b'}</span></p>}
  </div>
})
export default VisualEditor
