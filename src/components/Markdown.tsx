import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import MermaidDiagram from './MermaidDiagram'

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

export default function Markdown({ content }: { content: string }) {
  return <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm, limitMermaidDiagrams]} skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    // Remote images can disclose a reader's IP address and private note URLs.
    img: ({ alt }) => <span className="image-placeholder">[Image: {alt || 'external image'} — remote images are not loaded]</span>,
    pre: ({ node, children }) => {
      const code = node?.children[0]
      if (code?.type === 'element' && code.tagName === 'code' && Array.isArray(code.properties.className) && code.properties.className.includes('language-mermaid')) {
        if (code.properties['data-mermaid-limit'] === 'true') return <div><p className="hint">Additional diagrams are shown as source. A note can preview up to 20 diagrams.</p><pre>{children}</pre></div>
        const source = code.children.map(child => child.type === 'text' ? child.value : '').join('').replace(/\n$/, '')
        return <MermaidDiagram source={source} />
      }
      return <pre>{children}</pre>
    },
  }}>{content}</ReactMarkdown></div>
}
