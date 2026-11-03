import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createContext, useContext, useMemo } from 'react'
import MermaidDiagram from './MermaidDiagram'
import { sourceMappedMarkdown } from '../lib/visual-markdown'

export type MarkdownEditing = { source: string; disabled: boolean; replace: (start: number, end: number, text: string) => void; editLink?: (link: HTMLElement) => void }
const EditingContext = createContext<MarkdownEditing | undefined>(undefined)

type MarkdownNode = { type: string; lang?: string | null; children?: MarkdownNode[]; data?: { hProperties?: Record<string, unknown> } }

function limitMermaidDiagrams() {
  return (tree: MarkdownNode) => {
    let diagrams = 0
    const visit = (node: MarkdownNode) => {
      if (node.type === 'code' && node.lang === 'mermaid' && ++diagrams > 20) {
        node.data ??= {}
        node.data.hProperties = { ...node.data.hProperties, 'data-mermaid-limit': 'true' }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

// Stable component types preserve diagram render jobs across background syncs
// and edits to surrounding prose. MermaidDiagram resets when its source changes.
const components: Components = {
  a: ({ children, href, node: _node, ...props }) => {
    const editing = useContext(EditingContext)
    return <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={editing ? event => { if (!event.ctrlKey && !event.metaKey) { event.preventDefault(); editing.editLink?.(event.currentTarget) } } : undefined}>{children}</a>
  },
  // Remote images can disclose a reader's IP address and private note URLs.
  img: ({ alt }) => <span className="image-placeholder" contentEditable={false}>[Image: {alt || 'external image'} — remote images are not loaded]</span>,
  input: ({ checked, node: _node, ...props }) => {
    const editing = useContext(EditingContext)
    return <input {...props} type="checkbox" checked={!!checked} disabled={!editing || editing.disabled} contentEditable={false} aria-label={checked ? 'Mark task incomplete' : 'Mark task complete'} onChange={event => {
      const item = event.currentTarget.closest<HTMLElement>('[data-task-start]')
      if (!editing || !item) return
      const start = Number(item.dataset.taskStart), end = Number(item.dataset.taskEnd)
      const marker = editing.source.slice(start, end).match(/^\s*(?:[-+*]|\d+[.)]) \[([ xX])\]/)
      if (marker) editing.replace(start + marker[0].lastIndexOf('[') + 1, start + marker[0].lastIndexOf('[') + 2, event.currentTarget.checked ? 'x' : ' ')
    }} />
  },
  pre: ({ node, children }) => {
    const editing = useContext(EditingContext)
    const code = node?.children[0]
    if (code?.type === 'element' && code.tagName === 'code' && Array.isArray(code.properties.className) && code.properties.className.includes('language-mermaid')) {
      if (code.properties['data-mermaid-limit'] === 'true') return <div><p className="hint">Additional diagrams are shown as source. A note can preview up to 20 diagrams.</p><pre>{children}</pre></div>
      const source = code.children.map(child => child.type === 'text' ? child.value : '').join('').replace(/\n$/, '')
      const start = Number(code.properties['data-source-start']), end = Number(code.properties['data-source-end'])
      return <div contentEditable={false}><MermaidDiagram source={source} sourceEditor={editing && Number.isFinite(start) && Number.isFinite(end) ? <textarea aria-label="Mermaid source" value={source} disabled={editing.disabled} onChange={event => editing.replace(start, end, event.currentTarget.value)} spellCheck={false} /> : undefined} /></div>
    }
    return <pre>{children}</pre>
  },
}

export default function Markdown({ content, editing }: { content: string; editing?: MarkdownEditing }) {
  const plugins = useMemo(() => editing ? [remarkGfm, limitMermaidDiagrams, [sourceMappedMarkdown, { source: content }] as [typeof sourceMappedMarkdown, { source: string }]] : [remarkGfm, limitMermaidDiagrams], [content, !!editing])
  return <EditingContext.Provider value={editing}><div className="markdown-preview"><ReactMarkdown remarkPlugins={plugins} skipHtml components={components}>{content}</ReactMarkdown></div></EditingContext.Provider>
}
