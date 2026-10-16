import { useEffect, useRef, useState } from 'react'
import mermaidAsset from 'mermaid/dist/mermaid.min.js?url'
import runtimeAsset from './mermaid-runtime.js?url&no-inline'
import './MermaidDiagram.css'

const MAX_SOURCE_BYTES = 20_000
const MAX_SVG_BYTES = 2_000_000
const RENDER_TIMEOUT_MS = 20_000
const FAILED = 'Unable to render this Mermaid diagram. Check its syntax.'
const DISPLAY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function sourceError(source: string): string | null {
  if (source.length > MAX_SOURCE_BYTES || new TextEncoder().encode(source).length > MAX_SOURCE_BYTES || source.split('\n').length > 500) {
    return 'This Mermaid diagram is too large. Use at most 20 KB and 500 lines.'
  }
  // Keep note-provided configuration out of the renderer. The sandbox and CSP,
  // rather than this check, are the boundary for untrusted diagram content.
  if (/^\s*---(?:\r?\n|$)/.test(source) || /%%\s*\{/.test(source)) {
    return 'Mermaid configuration directives and frontmatter are not supported. Use diagram syntax only.'
  }
  return null
}

function runtimeDocument(token: string): string {
  const renderer = new URL(mermaidAsset, window.location.href).href
  const runtime = new URL(runtimeAsset, window.location.href).href
  const policy = `${DISPLAY_POLICY}; script-src ${renderer} ${runtime}`
  return `<!doctype html><html data-job="${escapeAttribute(token)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;background:white}body{font-family:Arial,sans-serif}#diagram{padding:8px}svg{max-width:100%;height:auto}</style></head><body><div id="diagram"></div><script src="${escapeAttribute(renderer)}"></script><script src="${escapeAttribute(runtime)}"></script></body></html>`
}

function displayDocument(svg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${DISPLAY_POLICY}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;background:white}body{padding:8px;font-family:Arial,sans-serif}svg{display:block;width:100%;max-width:100%;height:auto}a{pointer-events:none}</style></head><body>${svg}</body></html>`
}

function DiagramJob({ source }: { source: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const [runtime, setRuntime] = useState<string>()
  const [result, setResult] = useState<{ svg: string; ratio: number }>()
  const [error, setError] = useState<string | null>(() => sourceError(source))
  const [width, setWidth] = useState(640)

  useEffect(() => {
    if (sourceError(source)) return
    const token = crypto.randomUUID()
    let active = true
    let requested = false
    const timer = window.setTimeout(() => {
      active = false
      setError('This Mermaid diagram could not be rendered in time. Try a smaller diagram.')
      setRuntime(undefined)
    }, RENDER_TIMEOUT_MS)
    const receive = (event: MessageEvent) => {
      if (!active || event.source !== frame.current?.contentWindow || !event.data || event.data.token !== token) return
      const message = event.data
      if (message.type === 'mermaid-ready' && !requested) {
        requested = true
        frame.current?.contentWindow?.postMessage({ type: 'mermaid-render', token, source }, '*')
      } else if (requested && (message.type === 'mermaid-result' || message.type === 'mermaid-error')) {
        active = false
        window.clearTimeout(timer)
        if (message.type === 'mermaid-result' && typeof message.svg === 'string' && message.svg.length <= MAX_SVG_BYTES &&
          Number.isFinite(message.width) && message.width > 0 && Number.isFinite(message.height) && message.height > 0 &&
          message.width <= 100_000 && message.height <= 100_000) {
          setResult({ svg: message.svg, ratio: message.height / message.width })
        } else setError(FAILED)
        setRuntime(undefined)
      }
    }
    window.addEventListener('message', receive)
    setRuntime(runtimeDocument(token))
    return () => {
      active = false
      window.clearTimeout(timer)
      window.removeEventListener('message', receive)
    }
  }, [source])

  useEffect(() => {
    if (!wrapper.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width
      if (Number.isFinite(next) && next > 0) setWidth(next)
    })
    observer.observe(wrapper.current)
    return () => observer.disconnect()
  }, [])

  return <div className="mermaid-diagram" ref={wrapper}>
    {error ? <p className="mermaid-error" role="alert">{error}</p> : result ?
      <iframe key="display" className="mermaid-frame" title="Mermaid diagram" sandbox="" referrerPolicy="no-referrer" srcDoc={displayDocument(result.svg)} style={{ height: Math.min(1200, Math.max(96, Math.ceil(Math.max(1, width - 16) * result.ratio + 20))) }} /> : <>
        <p className="mermaid-loading" role="status">Rendering diagram…</p>
        {runtime && <iframe key="renderer" ref={frame} className="mermaid-renderer" title="Rendering Mermaid diagram" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={runtime} aria-hidden="true" tabIndex={-1} />}
      </>}
    <details className="mermaid-source"><summary>Diagram source</summary><pre><code>{source}</code></pre></details>
  </div>
}

export default function MermaidDiagram({ source }: { source: string }) {
  // Replacing the job also replaces its browsing context. Late messages from a
  // previous note/version can never supply a result for the current source.
  return <DiagramJob key={source} source={source} />
}
