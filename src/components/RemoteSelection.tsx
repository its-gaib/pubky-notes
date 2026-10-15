import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import './RemoteSelection.css'

export interface RemoteSelectionValue {
  start: number
  end: number
  direction: 'forward' | 'backward' | 'none'
  label: string
  color: string
}

interface Rect { left: number; top: number; width: number; height: number }
interface Overlay {
  viewport: Rect
  highlights: Rect[]
  caret: Rect | null
  label: { left: number; top: number } | null
}

const mirroredProperties = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'font-stretch', 'font-kerning', 'font-feature-settings', 'font-variation-settings',
  'font-variant-ligatures', 'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-indent', 'text-transform', 'text-rendering', 'direction',
  'writing-mode', 'text-orientation', 'tab-size', 'word-break', 'overflow-wrap',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
] as const

function visibleRect(rect: Rect, width: number, height: number): Rect | null {
  const left = Math.max(0, rect.left), top = Math.max(0, rect.top)
  const right = Math.min(width, rect.left + rect.width), bottom = Math.min(height, rect.top + rect.height)
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null
}

/** A visual-only layer beside a native textarea inside a positioned wrapper. */
export default function RemoteSelection({ textarea, content, selection }: {
  textarea: RefObject<HTMLTextAreaElement | null>
  content: string
  selection: RemoteSelectionValue | null
}) {
  const layer = useRef<HTMLDivElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const name = useRef<HTMLSpanElement>(null)
  const current = useRef({ content, selection }); current.current = { content, selection }
  const scheduleMeasure = useRef<(() => void) | null>(null)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const label = selection?.label.slice(0, 64) ?? ''
  const color = selection && /^#[a-f\d]{6}$/i.test(selection.color) ? selection.color : '#8b5cc7'

  useLayoutEffect(() => {
    const input = textarea.current, root = layer.current, measuring = mirror.current
    if (!input || !root || !measuring) return
    let frame = 0, disposed = false
    const measure = () => {
      frame = 0
      if (disposed) return
      const peer = current.current.selection
      if (!peer || !Number.isFinite(peer.start) || !Number.isFinite(peer.end) || !input.clientWidth || !input.clientHeight) {
        setOverlay(null)
        return
      }
      const text = current.current.content
      const start = Math.max(0, Math.min(text.length, Math.trunc(Math.min(peer.start, peer.end))))
      const end = Math.max(start, Math.min(text.length, Math.trunc(Math.max(peer.start, peer.end))))
      const active = peer.direction === 'backward' ? start : end
      const computed = getComputedStyle(input)
      for (const property of mirroredProperties) measuring.style.setProperty(property, computed.getPropertyValue(property))
      const borderLeft = parseFloat(computed.borderLeftWidth) || 0, borderRight = parseFloat(computed.borderRightWidth) || 0
      const borderTop = parseFloat(computed.borderTopWidth) || 0
      // clientWidth excludes the scrollbar but includes padding. Giving the
      // mirror that exact text viewport reproduces native textarea wrapping.
      measuring.style.width = `${input.clientWidth + borderLeft + borderRight}px`
      measuring.style.whiteSpace = input.wrap === 'off' ? 'pre' : 'pre-wrap'
      measuring.style.overflowWrap = input.wrap === 'off' ? 'normal' : computed.overflowWrap || 'break-word'
      // The sentinel gives an empty final line a measurable caret rectangle.
      const mirroredText = `${text}\u200b`
      if (measuring.textContent !== mirroredText) measuring.textContent = mirroredText
      const textNode = measuring.firstChild
      if (!textNode) { setOverlay(null); return }
      const rootBox = root.getBoundingClientRect(), inputBox = input.getBoundingClientRect(), mirrorBox = measuring.getBoundingClientRect()
      const viewport = { left: inputBox.left - rootBox.left + borderLeft, top: inputBox.top - rootBox.top + borderTop, width: input.clientWidth, height: input.clientHeight }
      const lineHeight = parseFloat(computed.lineHeight) || (parseFloat(computed.fontSize) || 15) * 1.2
      const localRect = (rect: DOMRect): Rect => ({
        left: rect.left - mirrorBox.left - borderLeft - input.scrollLeft,
        top: rect.top - mirrorBox.top - borderTop - input.scrollTop - Math.max(0, lineHeight - rect.height) / 2,
        width: rect.width,
        height: Math.max(lineHeight, rect.height),
      })
      const highlights: Rect[] = []
      if (end > start) {
        const range = document.createRange()
        range.setStart(textNode, start); range.setEnd(textNode, end)
        // Clip before rendering: a long selection should create only as many
        // elements as there are visible lines, not one element per document line.
        for (const rect of range.getClientRects()) {
          const clipped = visibleRect(localRect(rect), viewport.width, viewport.height)
          if (clipped && highlights.length < 512) highlights.push(clipped)
        }
      }
      const cursor = document.createRange()
      cursor.setStart(textNode, active); cursor.collapse(true)
      let cursorBox = [...cursor.getClientRects()].find(rect => rect.height > 0)
      if (!cursorBox) {
        cursor.setEnd(textNode, active + 1)
        cursorBox = [...cursor.getClientRects()].find(rect => rect.height > 0)
      }
      let caret: Rect | null = null
      let position: Overlay['label'] = null
      if (cursorBox) {
        const raw = { ...localRect(cursorBox), width: 2 }
        // An offscreen caret should not leave a misleading floating name at an
        // edge. A partially visible caret remains clipped with its text line.
        if (raw.left >= 0 && raw.left <= viewport.width && raw.top < viewport.height && raw.top + raw.height > 0) {
          caret = visibleRect({ ...raw, left: Math.min(raw.left, viewport.width - 2) }, viewport.width, viewport.height)
          const labelWidth = Math.min(name.current?.offsetWidth || 120, viewport.width)
          const labelHeight = name.current?.offsetHeight || 19
          const preferredTop = raw.top >= labelHeight ? raw.top - labelHeight : raw.top + raw.height
          position = {
            left: Math.max(0, Math.min(raw.left, viewport.width - labelWidth)),
            top: Math.max(0, Math.min(preferredTop, viewport.height - labelHeight)),
          }
        }
      }
      setOverlay({ viewport, highlights, caret, label: position })
    }
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(measure) }
    scheduleMeasure.current = schedule
    input.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resize?.observe(input)
    if (input.parentElement) resize?.observe(input.parentElement)
    if (name.current) resize?.observe(name.current)
    const attributes = new MutationObserver(schedule)
    attributes.observe(input, { attributes: true, attributeFilter: ['class', 'style', 'wrap'] })
    attributes.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    document.fonts?.addEventListener('loadingdone', schedule)
    void document.fonts?.ready.then(schedule)
    schedule()
    return () => {
      disposed = true
      if (frame) cancelAnimationFrame(frame)
      scheduleMeasure.current = null
      resize?.disconnect(); attributes.disconnect()
      input.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.fonts?.removeEventListener('loadingdone', schedule)
    }
  }, [textarea])

  useLayoutEffect(() => { scheduleMeasure.current?.() }, [content, selection?.start, selection?.end, selection?.direction, label, color])

  return <div className="remote-selection-layer" ref={layer} aria-hidden="true">
    <div className="remote-selection-mirror" ref={mirror} />
    <div className="remote-selection-viewport" style={overlay?.viewport ?? { visibility: 'hidden' }}>
      {selection && overlay?.highlights.map((rect, index) => <span key={index} className="remote-selection-highlight" style={{ ...rect, backgroundColor: color }} />)}
      {selection && overlay?.caret && <span className="remote-selection-caret" style={{ ...overlay.caret, backgroundColor: color }} />}
      <span ref={name} className="remote-selection-name" style={{ ...(overlay?.label ?? { left: 0, top: 0 }), backgroundColor: color, visibility: selection && overlay?.label ? 'visible' : 'hidden' }}>{label}</span>
    </div>
  </div>
}
