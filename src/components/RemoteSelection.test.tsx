// @vitest-environment jsdom
import { useRef } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RemoteSelection from './RemoteSelection'
import type { RemoteSelectionValue } from './RemoteSelection'

const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
let rectangles: (range: Range) => DOMRect[]

function Fixture({ selection, content = 'abcdefgh\n' }: { selection: RemoteSelectionValue | null; content?: string }) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  return <div style={{ position: 'relative' }}><textarea ref={textarea} value={content} readOnly style={{ padding: 0, border: 0, fontSize: 14, lineHeight: '20px' }} /><RemoteSelection textarea={textarea} content={content} selection={selection} /></div>
}

beforeEach(() => {
  rectangles = range => range.collapsed
    ? [new DOMRect(range.startOffset * 10, 20, 0, 20)]
    : [new DOMRect(20, 0, 40, 20), new DOMRect(0, 20, 90, 20), new DOMRect(0, 40, 30, 20)]
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: function(this: Range) { return rectangles(this) } })
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function(this: Element) { return this instanceof HTMLTextAreaElement ? 100 : 0 })
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function(this: Element) { return this instanceof HTMLTextAreaElement ? 60 : 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(40)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(19)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 60))
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks()
  if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects)
  else Reflect.deleteProperty(Range.prototype, 'getClientRects')
})

const peer: RemoteSelectionValue = { start: 2, end: 6, direction: 'backward', label: '<img src=x onerror=alert(1)>', color: '#123456' }

it('marks the active end of a backward selection and renders a name only as text', async () => {
  const view = render(<Fixture selection={peer} />)
  await waitFor(() => expect(view.container.querySelector<HTMLElement>('.remote-selection-caret')?.style.left).toBe('20px'))
  expect(view.container.querySelector('.remote-selection-layer')?.getAttribute('aria-hidden')).toBe('true')
  expect(view.container.querySelector('.remote-selection-name')?.textContent).toBe(peer.label)
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.container.querySelectorAll('.remote-selection-highlight')).toHaveLength(3)
  expect(view.container.querySelector('textarea')?.value).toBe('abcdefgh\n')
  view.rerender(<Fixture selection={{ ...peer, direction: 'forward' }} />)
  await waitFor(() => expect(view.container.querySelector<HTMLElement>('.remote-selection-caret')?.style.left).toBe('60px'))
})

it('tracks native scrolling, clips selection lines, and hides an offscreen caret and name', async () => {
  const view = render(<Fixture selection={peer} />)
  await waitFor(() => expect(view.container.querySelector('.remote-selection-caret')).not.toBeNull())
  const input = view.container.querySelector('textarea')!
  input.scrollTop = 40
  fireEvent.scroll(input)
  await waitFor(() => expect(view.container.querySelector('.remote-selection-caret')).toBeNull())
  expect(view.container.querySelectorAll('.remote-selection-highlight')).toHaveLength(1)
  expect(view.container.querySelector<HTMLElement>('.remote-selection-highlight')?.style.top).toBe('0px')
  expect(view.container.querySelector<HTMLElement>('.remote-selection-name')?.style.visibility).toBe('hidden')
})

it('measures a trailing empty line using the sentinel when a collapsed range has no rectangle', async () => {
  rectangles = range => range.collapsed ? [] : [new DOMRect(0, 20, 0, 20)]
  const view = render(<Fixture content={'a\n'} selection={{ ...peer, start: 2, end: 2 }} />)
  await waitFor(() => expect(view.container.querySelector<HTMLElement>('.remote-selection-caret')?.style.top).toBe('20px'))
  expect(view.container.querySelector('.remote-selection-mirror')?.textContent).toBe('a\n\u200b')
  expect(view.container.querySelectorAll('.remote-selection-highlight')).toHaveLength(0)
})

it('clears presence immediately and rejects non-finite positions', async () => {
  const view = render(<Fixture selection={peer} />)
  await waitFor(() => expect(view.container.querySelector('.remote-selection-caret')).not.toBeNull())
  view.rerender(<Fixture selection={null} />)
  expect(view.container.querySelector('.remote-selection-caret')).toBeNull()
  expect(view.container.querySelectorAll('.remote-selection-highlight')).toHaveLength(0)
  view.rerender(<Fixture selection={{ ...peer, start: Infinity }} />)
  await waitFor(() => expect(view.container.querySelector('.remote-selection-caret')).toBeNull())
})
