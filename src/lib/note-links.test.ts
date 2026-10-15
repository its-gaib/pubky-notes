import { describe, expect, it } from 'vitest'
import { notePath, noteUrl, parseNoteRoute } from './note-links'

const owner = 'y'.repeat(52)
const id = 'a-note_123'
const location = (pathname: string, search = '') => ({ pathname, search })

describe('stable note addresses', () => {
  it('round-trips private, public and local paths without losing their access kind', () => {
    expect(parseNoteRoute(location(notePath(owner, id)))).toEqual({ kind: 'private', owner, id })
    expect(parseNoteRoute(location(notePath(owner, id, 'pub')))).toEqual({ kind: 'public', owner, id })
    expect(parseNoteRoute(location(notePath(null, id)))).toEqual({ kind: 'local', id })
    expect(noteUrl(owner, id, 'priv', 'https://pubky-notes.vercel.app')).toBe(`https://pubky-notes.vercel.app/pubky${owner}/priv/notes/${id}.json`)
  })

  it('normalizes bare and prefixed Pubky identifiers to one address', () => {
    expect(notePath(`pubky${owner}`, id)).toBe(notePath(owner, id))
    expect(parseNoteRoute(location(`/${owner}/priv/notes/${id}.json`))).toEqual({ kind: 'private', owner, id })
  })

  it('keeps old public links public and ignores unrelated tracking parameters', () => {
    expect(parseNoteRoute(location('/', `?owner=pubky${owner}&note=${id}&utm_source=test`))).toEqual({ kind: 'public', owner, id })
    expect(parseNoteRoute(location('/', '?utm_source=test'))).toEqual({ kind: 'home' })
  })

  it.each([
    `/pubky${owner}/priv/notes/../secret.json`,
    `/pubky${owner}/priv/notes/%2e%2e.json`,
    `/pubky${owner}/priv/notes/a%2fb.json`,
    `/pubky${owner}/priv/notes/${id}.json/extra`,
    `/pubky${owner}/priv/notes/${id}.json/`,
    `/pubky${owner}/priv/notest/${id}.json`,
    `/pubky${owner}/priv/notes/${'a'.repeat(81)}.json`,
    '/local/notes/.json',
    '/local/notes/a%00b.json',
    '/local/pub/notes/a.json',
    '/not-an-owner/priv/notes/a.json',
    `/pubky${'a'.repeat(51)}/priv/notes/a.json`,
    `/pubky${owner}/other/notes/a.json`,
  ])('rejects malformed or non-note path %s', pathname => {
    expect(parseNoteRoute(location(pathname))).toEqual({ kind: 'invalid' })
  })

  it.each([
    `?owner=${owner}`,
    `?note=${id}`,
    `?owner=${owner}&owner=${owner}&note=${id}`,
    `?owner=${owner}&note=${id}&note=other`,
    `?owner=${owner}&note=..%2Fsecret`,
    '?owner=https%3A%2F%2Fexample.com&note=a',
  ])('rejects invalid or ambiguous legacy query %s', search => {
    expect(parseNoteRoute(location('/', search))).toEqual({ kind: 'invalid' })
  })

  it('does not mix private paths with legacy public query selectors', () => {
    expect(parseNoteRoute(location(notePath(owner, id), `?owner=${owner}&note=other`))).toEqual({ kind: 'invalid' })
  })

  it('does not generate arbitrary storage locations or publish local notes', () => {
    expect(() => notePath(owner, '../secret')).toThrow('Invalid note identifier')
    expect(() => notePath(`pubky${owner}/priv/other`, id)).toThrow('Invalid Pubky identifier')
    expect(() => notePath(null, id, 'pub')).toThrow('Local notes do not have a public address')
  })
})
