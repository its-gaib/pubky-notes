import diff from 'fast-diff'
import { decodeString } from 'micromark-util-decode-string'

/** Map rendered UTF-16 boundaries back to the original Markdown. Escapes,
 * entities and indentation belong to the character they produce, so editing
 * one leaf never reserializes surrounding Markdown. */
export function renderedOffsets(source: string, rendered: string): number[] {
  const decodedOffsets = [0]
  let decoded = '', position = 0
  const tokens = /\\[!-/:-@\[-`{-~]|&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});|[\s\S]/gi
  for (const match of source.matchAll(tokens)) {
    const token = match[0], text = decodeString(token)
    decoded += text
    for (let index = 0; index < text.length; index++) decodedOffsets.push(position + (index === text.length - 1 ? token.length : 0))
    position += token.length
  }
  return plainOffsets(decoded, rendered).map(offset => decodedOffsets[offset])
}

export function plainOffsets(source: string, rendered: string): number[] {
  const offsets = [0]
  let original = 0
  for (const [operation, text] of diff(source, rendered)) {
    if (operation === -1) {
      original += text.length
      // Markdown can omit structural prefixes inside one rendered text
      // leaf (for example `> ` after a soft newline). The next visible
      // character starts after that prefix, so editing it preserves syntax.
      offsets[offsets.length - 1] = original
    }
    else for (let index = 0; index < text.length; index++) {
      if (operation === 0) original++
      offsets.push(original)
    }
  }
  offsets[offsets.length - 1] = source.length
  return offsets
}

export function expandMulticharReferences(source: string): string {
  return source.replace(/\\[!-/:-@\[-`{-~]|&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi, token => {
    if (token.startsWith('\\')) return token
    const decoded = decodeString(token)
    return decoded !== token && decoded.length > 1 ? decoded.replace(/([\\`*_\[\]<>|])/g, '\\$1') : token
  })
}

type MarkdownNode = {
  type: string; value?: string; checked?: boolean | null; lang?: string | null
  url?: string; align?: ('left' | 'right' | 'center' | null)[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown>; hChildren?: unknown[] }
}

export function sourceMappedMarkdown({ source }: { source: string }) {
  return (tree: MarkdownNode) => {
    function visit(node: MarkdownNode) {
      const start = node.position?.start.offset, end = node.position?.end.offset
      // Table edits use the parsed content bounds, excluding cell padding.
      // Preserve these before adding editable whitespace presentation leaves.
      const cellContentStart = node.type === 'tableCell' ? node.children?.[0]?.position?.start.offset : undefined
      const cellContentEnd = node.type === 'tableCell' ? node.children?.at(-1)?.position?.end.offset : undefined
      if (['paragraph', 'heading', 'tableCell'].includes(node.type) && end !== undefined && node.children?.length) {
        const previous = node.children.at(-1)?.position?.end.offset
        const tailEnd = node.type === 'tableCell' && source[end - 1] === '|' ? end - 1 : end
        const tail = previous === undefined ? '' : source.slice(previous, tailEnd)
        // CommonMark drops spaces at the end of a block. Keep an editable
        // leaf for them so the next keystroke stays after the typed space.
        if (previous !== undefined && /^[ \t]+$/.test(tail)) node.children.push({ type: 'text', value: tail, position: { start: { offset: previous }, end: { offset: tailEnd } } })
      }
      if (node.type === 'listItem' && !node.children?.length && end !== undefined) {
        const position = { start: { offset: end }, end: { offset: end } }
        node.children = [{ type: 'paragraph', position, children: [{ type: 'text', value: '\u200b', position }] }]
      }
      if ((node.type === 'heading' || node.type === 'tableCell' || node.type === 'paragraph') && !node.children?.length && start !== undefined && end !== undefined) {
        const at = node.type === 'tableCell' ? Math.min(end, start + (source[start] === '|' ? 1 : 0) + (/\s/.test(source[start + 1] ?? '') ? 1 : 0)) : end
        const position = { start: { offset: at }, end: { offset: at } }
        node.children = [{ type: 'text', value: '\u200b', position }]
      }
      if (start !== undefined && end !== undefined) {
        if (['heading', 'listItem', 'blockquote'].includes(node.type)) {
          node.data ??= {}
          node.data.hProperties = { ...node.data.hProperties, 'data-block-start': start, 'data-block-end': end }
        }
        if (node.type === 'table' || node.type === 'tableRow' || node.type === 'tableCell') {
          node.data ??= {}
          node.data.hProperties = { ...node.data.hProperties, 'data-table-start': start, 'data-table-end': end }
          if (node.type === 'table') node.data.hProperties['data-table-align'] = JSON.stringify(node.align ?? [])
          if (node.type === 'tableCell') {
            node.data.hProperties['data-cell-start'] = cellContentStart ?? end
            node.data.hProperties['data-cell-end'] = cellContentEnd ?? end
          }
        }
        if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
          let from = start, to = end
          const raw = source.slice(start, end)
          if (node.type === 'inlineCode') {
            const fence = raw.match(/^`+/)?.[0].length ?? 1
            from += fence; to -= fence
          } else if (node.type === 'code') {
            const fence = raw.match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n/)
            if (fence) {
              from += fence[0].length
              const closing = source.slice(from, end).match(/\r?\n {0,3}(?:`{3,}|~{3,})\s*$/)
              if (closing) to -= closing[0].length
            }
          }
          node.data ??= {}
          if (node.type === 'text') node.data.hName = 'span'
          node.data.hProperties = { ...node.data.hProperties, 'data-source-start': from, 'data-source-end': to, 'data-source-kind': node.type }
          if (node.type === 'inlineCode' || node.type === 'code') Object.assign(node.data.hProperties, { 'data-format-start': start, 'data-format-end': end })
          // Preserve original text-node whitespace instead of HAST's trimLines.
          if (node.type === 'text') node.data.hChildren = [{ type: 'text', value: node.value ?? '' }]
        } else if (['strong', 'emphasis', 'delete', 'link', 'linkReference'].includes(node.type)) {
          node.data ??= {}
          node.data.hProperties = { ...node.data.hProperties, 'data-format-start': start, 'data-format-end': end, 'data-format-kind': node.type }
          if (node.type === 'link' || node.type === 'linkReference') {
            node.data.hProperties['data-link-label-start'] = node.children?.[0]?.position?.start.offset ?? start + 1
            node.data.hProperties['data-link-label-end'] = node.children?.at(-1)?.position?.end.offset ?? start + 1
          }
        } else if (node.type === 'listItem' && typeof node.checked === 'boolean') {
          node.data ??= {}
          node.data.hProperties = { ...node.data.hProperties, 'data-task-start': start, 'data-task-end': end }
        }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

export function paragraphInsertion(source: string, position: number): string {
  const line = source.slice(source.lastIndexOf('\n', position - 1) + 1, position)
  const list = line.match(/^(\s*)([-+*]|\d+[.)]) (\[[ xX]\] )?/)
  if (list) {
    const marker = /^\d/.test(list[2]) ? list[2].replace(/^\d+/, value => String(Number(value) + 1)) : list[2]
    return `\n${list[1]}${marker} ${list[3] ? '[ ] ' : ''}`
  }
  const quote = line.match(/^(\s*>\s?)/)
  return quote ? `\n${quote[1]}` : '\n\n'
}
