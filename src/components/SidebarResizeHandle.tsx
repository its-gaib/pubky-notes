import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'

interface Props {
  label: string
  controls: string
  width: number
  min: number
  max: number
  defaultWidth: number
  onResize: (width: number) => void
}

export default function SidebarResizeHandle({ label, controls, width, min, max, defaultWidth, onResize }: Props) {
  const drag = useRef<{ pointerId: number; startX: number; width: number; element: HTMLDivElement } | null>(null)
  const [dragging, setDragging] = useState(false)

  function release() {
    const active = drag.current
    drag.current = null
    if (!active) return
    try { if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId) } catch { /* Capture may already be lost. */ }
  }
  useEffect(() => release, [])

  function resize(value: number) {
    if (Number.isFinite(value)) onResize(Math.round(Math.min(max, Math.max(min, value))))
  }
  function start(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || drag.current) return
    event.preventDefault()
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { return }
    drag.current = { pointerId: event.pointerId, startX: event.clientX, width, element: event.currentTarget }
    setDragging(true)
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current
    if (!active || event.pointerId !== active.pointerId) return
    event.preventDefault()
    resize(active.width + event.clientX - active.startX)
  }
  function stop(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    release(); setDragging(false)
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const value = event.key === 'ArrowLeft' ? width - 10 : event.key === 'ArrowRight' ? width + 10
      : event.key === 'Home' ? min : event.key === 'End' ? max : null
    if (value === null) return
    event.preventDefault(); resize(value)
  }

  return <div className={`sidebar-resize-handle ${dragging ? 'is-dragging' : ''}`} role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-controls={controls} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} pixels`} title="Drag to resize · double-click to reset" onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onKeyDown={key} onDoubleClick={() => resize(defaultWidth)} />
}
