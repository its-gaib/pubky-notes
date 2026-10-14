import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default function Markdown({ content }: { content: string }) {
  return <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    // Remote images can disclose a reader's IP address and private note URLs.
    img: ({ alt }) => <span className="image-placeholder">[Image: {alt || 'external image'} — remote images are not loaded]</span>,
  }}>{content}</ReactMarkdown></div>
}
