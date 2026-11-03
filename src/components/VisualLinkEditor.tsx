import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { safeLinkUrl } from '../lib/visual-tools'
import './VisualEditorTools.css'

export type LinkDraft = { source: string; start: number; end: number; label: string; rawLabel: string; href: string; existing: boolean }
export default function VisualLinkEditor({ draft, close, save, remove }: { draft: LinkDraft; close(): void; save(label: string, url: string): void; remove(): void }) {
  const [label, setLabel] = useState(draft.label)
  const [url, setUrl] = useState(draft.href)
  const [error, setError] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { panel.current?.querySelector<HTMLInputElement>(draft.existing ? '[name="url"]' : '[name="label"]')?.focus() }, [draft.existing])
  return createPortal(<div className="visual-link-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <div ref={panel} className="visual-link-dialog" role="dialog" aria-modal="true" aria-label={draft.existing ? 'Edit link' : 'Insert link'} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button:not([disabled])')]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <h2>{draft.existing ? 'Edit link' : 'Insert link'}</h2>
      <form onSubmit={event => {
        event.preventDefault()
        try { const checked = safeLinkUrl(url); if (!label.trim()) throw new Error('Enter the text for this link.'); save(label, checked) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save this link.') }
      }}>
        <label>Link text<input name="label" value={label} maxLength={10_000} onChange={event => setLabel(event.target.value)} /></label>
        <label>Link URL<input name="url" inputMode="url" value={url} placeholder="https://example.com" maxLength={4096} onChange={event => setUrl(event.target.value)} /></label>
        {error && <p role="alert">{error}</p>}
        <div className="visual-link-buttons">
          {draft.existing && <button type="button" className="button ghost" onClick={remove}>Remove link</button>}
          <button type="button" className="button secondary" onClick={close}>Cancel</button>
          <button type="submit" className="button primary">Save link</button>
        </div>
      </form>
    </div>
  </div>, document.body)
}
