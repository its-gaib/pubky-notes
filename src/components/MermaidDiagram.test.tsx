// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MermaidDiagram from './MermaidDiagram'
import Markdown from './Markdown'

afterEach(() => { cleanup(); vi.useRealTimers() })

function job() {
  const frame = screen.getByTitle('Rendering Mermaid diagram') as HTMLIFrameElement
  const token = /data-job="([^"]+)"/.exec(frame.srcdoc)![1]
  return { frame, token, source: frame.contentWindow! }
}
function message(current: ReturnType<typeof job>, data: Record<string, unknown>, source: MessageEventSource = current.source) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { source, data: { token: current.token, ...data } })) })
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>Start</text></svg>'
function finish(current: ReturnType<typeof job>, overrides: Record<string, unknown> = {}) {
  message(current, { type: 'mermaid-ready' })
  message(current, { type: 'mermaid-result', svg, width: 200, height: 100, ...overrides })
}

describe('Mermaid previews', () => {
  it('renders only Mermaid fences and preserves normal code, GFM tables, and Markdown HTML restrictions', () => {
    render(<Markdown content={'```mermaid\nflowchart LR\n  Start --> End\n```\n\n```js\nconst answer = 42\n```\n\n`mermaid`\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n<script>bad()</script>\n\n![private](https://example.org/image)'} />)
    expect(screen.getByTitle('Rendering Mermaid diagram')).toBeTruthy()
    expect(screen.getByText('const answer = 42').closest('pre')).toBeTruthy()
    expect(screen.getByText('mermaid').tagName).toBe('CODE')
    expect(screen.getByRole('table')).toBeTruthy()
    expect(document.querySelector('script, img')).toBeNull()
    expect(screen.getByText(/remote images are not loaded/)).toBeTruthy()
  })

  it('isolates rendering, sends source only after the matching handshake, and removes scripts from the final frame', () => {
    const source = 'flowchart LR\n  Private --> Text'
    render(<MermaidDiagram source={source} />)
    const current = job()
    expect(current.frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(current.frame.srcdoc).toContain("default-src 'none'")
    expect(current.frame.srcdoc).toContain("base-uri 'none'")
    expect(current.frame.srcdoc).not.toContain(source)
    const send = vi.spyOn(current.source, 'postMessage')
    message(current, { type: 'mermaid-ready', token: 'wrong' })
    message(current, { type: 'mermaid-ready' }, window)
    expect(send).not.toHaveBeenCalled()
    message(current, { type: 'mermaid-ready' })
    message(current, { type: 'mermaid-ready' })
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'mermaid-render', token: current.token, source }, '*')
    message(current, { type: 'mermaid-result', svg, width: 200, height: 100 })
    const display = screen.getByTitle('Mermaid diagram') as HTMLIFrameElement
    expect(display).not.toBe(current.frame)
    expect(display.getAttribute('sandbox')).toBe('')
    expect(display.srcdoc).toContain(svg)
    expect(display.srcdoc).toContain("default-src 'none'")
    expect(display.srcdoc).not.toContain('<script')
    expect(document.querySelector('svg')).toBeNull()
    expect(screen.queryByTitle('Rendering Mermaid diagram')).toBeNull()
  })

  it('bounds the number of isolated renderers in a note', () => {
    render(<Markdown content={Array.from({ length: 22 }, (_, index) => `\x60\x60\x60mermaid\nflowchart LR\n A${index} --> B\n\x60\x60\x60`).join('\n\n')} />)
    expect(screen.getAllByTitle('Rendering Mermaid diagram')).toHaveLength(20)
    expect(screen.getAllByText(/Additional diagrams are shown as source/)).toHaveLength(2)
  })

  it.each([
    ['unchanged Markdown during background sync', 'Before the diagram', 'After the diagram'],
    ['surrounding prose changes', 'Updated introduction', 'Updated conclusion'],
  ])('keeps the completed diagram visible across %s', (_, introduction, conclusion) => {
    const content = (before: string, after: string) => `${before}\n\n\x60\x60\x60mermaid\nflowchart LR\n A --> B\n\x60\x60\x60\n\n${after}`
    const view = render(<Markdown content={content('Before the diagram', 'After the diagram')} />)
    finish(job())
    const display = screen.getByTitle('Mermaid diagram') as HTMLIFrameElement
    const renderedDocument = display.srcdoc

    view.rerender(<Markdown content={content(introduction, conclusion)} />)

    expect(screen.queryByTitle('Mermaid diagram')).toBe(display)
    expect(display.isConnected).toBe(true)
    expect(display.srcdoc).toBe(renderedDocument)
    expect(screen.queryByTitle('Rendering Mermaid diagram')).toBeNull()
    expect(screen.getByText(introduction)).toBeTruthy()
    expect(screen.getByText(conclusion)).toBeTruthy()
  })

  it('renders fresh output when the Mermaid fence changes and ignores the previous job', () => {
    const content = (target: string) => `\x60\x60\x60mermaid\nflowchart LR\n A --> ${target}\n\x60\x60\x60`
    const view = render(<Markdown content={content('B')} />)
    const previous = job()
    finish(previous)

    view.rerender(<Markdown content={content('C')} />)
    const current = job()
    expect(current.token).not.toBe(previous.token)
    finish(previous)
    expect(screen.queryByTitle('Mermaid diagram')).toBeNull()

    const updatedSvg = svg.replace('Start', 'Updated diagram')
    finish(current, { svg: updatedSvg })
    expect((screen.getByTitle('Mermaid diagram') as HTMLIFrameElement).srcdoc).toContain(updatedSvg)
    expect(screen.queryByTitle('Rendering Mermaid diagram')).toBeNull()
  })

  it('ignores output before the handshake and from a previous source or unmounted preview', () => {
    const view = render(<MermaidDiagram source="flowchart LR\n A --> B" />)
    const previous = job()
    message(previous, { type: 'mermaid-result', svg, width: 200, height: 100 })
    expect(screen.queryByTitle('Mermaid diagram')).toBeNull()
    view.rerender(<MermaidDiagram source="flowchart LR\n C --> D" />)
    const current = job()
    finish(previous)
    expect(screen.queryByTitle('Mermaid diagram')).toBeNull()
    finish(current)
    expect(screen.getByTitle('Mermaid diagram')).toBeTruthy()
    view.unmount()
    finish(current)
    expect(screen.queryByTitle('Mermaid diagram')).toBeNull()
  })

  it.each([
    'x'.repeat(20_001),
    '📝'.repeat(5_001),
    'a\n'.repeat(501),
    '---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\nA --> B',
    '%%{init: { securityLevel: "loose" }}%%\nflowchart LR\nA --> B',
  ])('rejects oversized sources and configuration overrides before loading the renderer', source => {
    render(<MermaidDiagram source={source} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it.each([{ width: Infinity }, { height: -1 }, { width: 1_000_000 }, { svg: 'x'.repeat(2_000_001) }])('rejects invalid or oversized renderer output', override => {
    render(<MermaidDiagram source="flowchart LR\n A --> B" />)
    finish(job(), override)
    expect(screen.getByRole('alert').textContent).toContain('Unable to render')
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('shows a readable error and keeps malformed source as escaped text', () => {
    render(<MermaidDiagram source={'broken <img src="https://example.org/private">'} />)
    const current = job()
    message(current, { type: 'mermaid-ready' })
    message(current, { type: 'mermaid-error', message: '<script>bad()</script>' })
    expect(screen.getByRole('alert').textContent).toBe('Unable to render this Mermaid diagram. Check its syntax.')
    expect(screen.getByText('broken <img src="https://example.org/private">')).toBeTruthy()
    expect(document.querySelector('script, img, iframe')).toBeNull()
  })

  it('removes a stalled renderer and ignores its late completion', () => {
    vi.useFakeTimers()
    render(<MermaidDiagram source="flowchart LR\n A --> B" />)
    const current = job()
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(screen.getByRole('alert').textContent).toContain('could not be rendered in time')
    expect(document.querySelector('iframe')).toBeNull()
    finish(current)
    expect(screen.queryByTitle('Mermaid diagram')).toBeNull()
  })
})
