export type InlineFormat = 'bold' | 'italic' | 'code' | 'heading' | 'list' | 'quote'
export type TableAction = 'row-before' | 'row-after' | 'column-before' | 'column-after' | 'delete-row' | 'delete-column'
export type TableModel = { start: number; end: number; rows: string[][]; align: ('left' | 'right' | 'center' | null)[]; row: number; column: number; prefix: string; newline: string }
export const TABLE_LIMIT = 20

export function safeLinkUrl(input: string): string {
  const value = input.trim()
  if (!value || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error('Enter a URL without spaces or control characters.')
  if (value.startsWith('/') && !/^\/[\\/]/.test(value) && !value.includes('\\')) return value
  if (value.startsWith('#')) return value
  if (!/^(https?:|mailto:)/i.test(value)) throw new Error('Use an https://, http://, mailto:, or notebook link.')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Enter a valid link URL.') }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) throw new Error('Enter a valid link URL.')
  return url.href
}

export function linkMarkdown(label: string, url: string, preserveLabel = false): string {
  const text = preserveLabel ? label : label.replace(/[\r\n]+/g, ' ').replace(/([\\`*_\[\]<>|])/g, '\\$1')
  const destination = safeLinkUrl(url).replace(/[<>\\]/g, char => encodeURIComponent(char))
  return `[${text || 'link'}](<${destination}>)`
}

export function tableModel(element: HTMLTableElement, content: string, selected: number): TableModel | undefined {
  const start = Number(element.dataset.tableStart), end = Number(element.dataset.tableEnd)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > content.length) return
  const rows = [...element.rows]
  let row = 0, column = 0
  const values = rows.map((entry, rowIndex) => [...entry.cells].map((cell, columnIndex) => {
    const from = Number(cell.dataset.cellStart), to = Number(cell.dataset.cellEnd)
    const cellStart = Number(cell.dataset.tableStart), cellEnd = Number(cell.dataset.tableEnd)
    if (selected >= cellStart && selected <= cellEnd) { row = rowIndex; column = columnIndex }
    return content.slice(from, to)
  }))
  if (!values.length || !values[0].length) return
  const raw = content.slice(start, end), newline = raw.includes('\r\n') ? '\r\n' : '\n'
  const delimiter = raw.split(/\r?\n/)[1] ?? ''
  const prefix = delimiter.match(/^[\t >]*/)?.[0] ?? ''
  const parsed = JSON.parse(element.dataset.tableAlign ?? '[]') as unknown
  const align = Array.isArray(parsed) ? parsed.map(value => value === 'left' || value === 'right' || value === 'center' ? value : null) : []
  return { start, end, rows: values, align, row, column, prefix, newline }
}

export function changeTable(model: TableModel, action: TableAction): { text: string; start: number; end: number } {
  const rows = model.rows.map(row => [...row]), align = [...model.align]
  let row = model.row, column = model.column
  const width = rows[0].length
  if (action === 'row-before' || action === 'row-after') {
    if (rows.length >= TABLE_LIMIT) throw new Error(`Tables can grow up to ${TABLE_LIMIT} rows.`)
    row += action === 'row-after' ? 1 : 0
    // The first row is always the Markdown table header; inserting before it
    // adds a body row below it instead of silently changing its role.
    row = Math.max(1, row)
    rows.splice(row, 0, Array.from({ length: width }, () => ''))
  } else if (action === 'column-before' || action === 'column-after') {
    if (width >= TABLE_LIMIT) throw new Error(`Tables can grow up to ${TABLE_LIMIT} columns.`)
    column += action === 'column-after' ? 1 : 0
    rows.forEach((entry, index) => entry.splice(column, 0, index ? '' : 'Header'))
    align.splice(column, 0, null)
  } else if (action === 'delete-row') {
    rows.splice(row, 1); row = Math.min(row, rows.length - 1)
  } else {
    rows.forEach(entry => entry.splice(column, 1)); align.splice(column, 1); column = Math.min(column, width - 2)
  }
  if (!rows.length || !rows[0].length) return { text: '', start: 0, end: 0 }
  let text = '', selectedStart = 0, selectedEnd = 0
  const append = (line: string) => { if (text) text += model.newline + model.prefix; text += line }
  rows.forEach((entry, rowIndex) => {
    const line = `| ${entry.join(' | ')} |`
    const base = text.length + (text ? model.newline.length + model.prefix.length : 0)
    if (rowIndex === row) {
      selectedStart = base + 2 + entry.slice(0, column).reduce((sum, cell) => sum + cell.length + 3, 0)
      selectedEnd = selectedStart + entry[column].length
    }
    append(line)
    if (rowIndex === 0) append(`| ${entry.map((_, index) => align[index] === 'left' ? ':---' : align[index] === 'right' ? '---:' : align[index] === 'center' ? ':---:' : '---').join(' | ')} |`)
  })
  return { text, start: selectedStart, end: selectedEnd }
}
