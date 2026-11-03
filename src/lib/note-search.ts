/** All search text stays in memory. A query is literal text, never a regular
 * expression, HTML, or a request sent to another service. */
export type SearchableRecord = {
  note: { id: string; title: string; content: string; folder?: string; updatedAt?: string; deleted?: boolean }
}
export type HighlightPart = { text: string; match: boolean }
export type SearchMatch<T> = {
  row: T
  title: HighlightPart[]
  excerpt: HighlightPart[]
  excerptText: string
  score: number
  bodyMatched: boolean
}
type Range = { start: number; end: number }

export function searchTokens(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/u).filter(Boolean))]
}

/** Map case-folded UTF-16 offsets to the original string. For example U+0130
 * expands when lowercased; highlight the original character without shifting
 * or deleting surrounding text. */
function originalRange(text: string, start: number, end: number): Range {
  let foldedOffset = 0, originalOffset = 0, from = text.length, to = text.length
  for (const character of text) {
    const foldedEnd = foldedOffset + character.toLowerCase().length
    if (start >= foldedOffset && start < foldedEnd) from = originalOffset
    if (end > foldedOffset && end <= foldedEnd) { to = originalOffset + character.length; break }
    foldedOffset = foldedEnd; originalOffset += character.length
  }
  return { start: from, end: to }
}

function firstRanges(text: string, tokens: readonly string[]): Range[] {
  const lower = text.toLowerCase()
  return tokens.flatMap(token => {
    const start = lower.indexOf(token)
    return start === -1 ? [] : [originalRange(text, start, start + token.length)]
  })
}

export function highlightText(text: string, query: string): HighlightPart[] {
  const tokens = searchTokens(query), lower = text.toLowerCase()
  const ranges: Range[] = []
  for (const token of tokens) {
    let from = 0
    while (from < lower.length) {
      const start = lower.indexOf(token, from)
      if (start === -1) break
      ranges.push(originalRange(text, start, start + token.length))
      from = start + token.length
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Range[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  const parts: HighlightPart[] = []
  let cursor = 0
  for (const range of merged) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), match: false })
    parts.push({ text: text.slice(range.start, range.end), match: true }); cursor = range.end
  }
  if (cursor < text.length || !parts.length) parts.push({ text: text.slice(cursor), match: false })
  return parts
}

export function noteExcerpt(content: string, query: string, length = 180): string {
  const limit = Number.isFinite(length) ? Math.max(20, Math.min(500, Math.floor(length))) : 180
  const text = content.replace(/\s+/gu, ' ').trim()
  if (text.length <= limit) return text
  const tokens = searchTokens(query), ranges = firstRanges(text, tokens)
  let start = 0, bestHits = -1
  for (const range of ranges) {
    // Keep the match near the beginning even at the end of a long note.
    // Backfilling the full window would hide it in a narrow, clamped sidebar.
    const candidate = Math.max(0, range.start - Math.min(24, Math.floor(limit / 8)))
    const window = text.slice(candidate, candidate + limit).toLowerCase()
    const hits = tokens.filter(token => window.includes(token)).length
    if (hits > bestHits) { start = candidate; bestHits = hits }
  }
  // Prefer a word boundary while retaining the first hit in the chosen window.
  if (start > 0) {
    const nextSpace = text.indexOf(' ', start)
    if (nextSpace !== -1 && nextSpace - start < 20 && !ranges.some(range => range.start >= start && range.start <= nextSpace)) start = nextSpace + 1
  }
  let end = Math.min(text.length, start + limit)
  // Do not split an emoji or another supplementary character at either edge.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start])) start--
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end])) end--
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Search every title and every character of the supplied note bodies. The
 * caller supplies its current account/view records; folder selection never
 * narrows this function. Every whitespace-separated term must match somewhere
 * in the title or content, including terms split between those fields. */
export function searchNotes<T extends SearchableRecord>(records: readonly T[], query: string): SearchMatch<T>[] {
  const tokens = searchTokens(query), phrase = query.trim().toLowerCase().replace(/\s+/gu, ' ')
  const matches: SearchMatch<T>[] = []
  for (const row of records) {
    const title = row.note.title.toLowerCase(), body = row.note.content.toLowerCase()
    if (!tokens.every(token => title.includes(token) || body.includes(token))) continue
    const bodyMatched = tokens.some(token => body.includes(token))
    const excerptText = noteExcerpt(row.note.content, query)
    let score = tokens.length ? tokens.reduce((total, token) => total + (title.includes(token) ? 20 : 1), 0) : 0
    if (phrase) {
      if (title === phrase) score += 200
      else if (title.includes(phrase)) score += 80
      if (body.replace(/\s+/gu, ' ').includes(phrase)) score += 10
    }
    matches.push({ row, title: highlightText(row.note.title || 'Untitled note', query), excerpt: highlightText(excerptText, query), excerptText, score, bodyMatched })
  }
  return tokens.length ? matches.sort((a, b) => b.score - a.score) : matches
}
