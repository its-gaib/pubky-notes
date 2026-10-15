// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import HistoryPanel from './HistoryPanel'

const entries = [
  { id: 'first', recordedAt: '2026-10-15T12:00:00.000Z' },
  { id: 'second', recordedAt: '2026-10-15T12:01:00.000Z' },
  { id: 'third', recordedAt: '2026-10-15T12:02:00.000Z' },
]
const versions: Record<string, { title: string; content: string }> = {
  first: { title: 'First draft', content: 'Early words' },
  second: { title: 'Next draft', content: 'More words' },
  third: { title: 'Current draft', content: 'Latest words' },
  fourth: { title: 'New remote draft', content: 'Words from another browser' },
}
function props(overrides: Partial<ComponentProps<typeof HistoryPanel>> = {}): ComponentProps<typeof HistoryPanel> {
  return { entries, current: versions.third, readVersion: vi.fn(id => versions[id]), disabled: false, restore: vi.fn(), close: vi.fn(), ...overrides }
}
function scrub(index: number) { fireEvent.change(screen.getByRole('slider', { name: 'Version timeline' }), { target: { value: String(index) } }) }
function tick() { act(() => { vi.advanceTimersByTime(800) }) }
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('note history', () => {
  it('opens the newest version and reads only the selected version, without changing the note', () => {
    const actions = props()
    render(<HistoryPanel {...actions} />)
    expect(screen.getByRole('region', { name: 'Note history' })).toBeTruthy()
    expect(screen.getByText('Version 3 of 3')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Current draft' })).toBeTruthy()
    expect(actions.readVersion).toHaveBeenCalledTimes(1)
    expect(actions.readVersion).toHaveBeenCalledWith('third')
    expect((screen.getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Matches your current note')).toBeTruthy()
    scrub(0)
    expect(screen.getByText('Early words')).toBeTruthy()
    expect(actions.readVersion).toHaveBeenCalledTimes(2)
    expect(actions.restore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
    expect(actions.restore).toHaveBeenCalledExactlyOnceWith('first')
  })

  it('plays from the oldest version when started at the newest and stops at the end', () => {
    vi.useFakeTimers()
    const actions = props()
    render(<HistoryPanel {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play history' }))
    expect(screen.getByText('Version 1 of 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pause history' })).toBeTruthy()
    tick()
    expect(screen.getByText('Version 2 of 3')).toBeTruthy()
    tick()
    expect(screen.getByText('Version 3 of 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Play history' })).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)
    expect(actions.restore).not.toHaveBeenCalled()
  })

  it('pauses on scrub and on the Pause button', () => {
    vi.useFakeTimers()
    const actions = props()
    render(<HistoryPanel {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play history' }))
    scrub(1)
    tick()
    expect(screen.getByText('Version 2 of 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Play history' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Play history' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause history' }))
    tick()
    expect(screen.getByText('Version 2 of 3')).toBeTruthy()
    expect(actions.restore).not.toHaveBeenCalled()
  })

  it('pins the selected ID when new versions arrive or the list is reordered', () => {
    const actions = props()
    const { rerender } = render(<HistoryPanel {...actions} />)
    const fourth = { id: 'fourth', recordedAt: '2026-10-15T12:03:00.000Z' }
    rerender(<HistoryPanel {...actions} entries={[...entries, fourth]} current={versions.fourth} />)
    expect(screen.getByRole('heading', { name: 'Current draft' })).toBeTruthy()
    expect(screen.getByText('Version 3 of 4')).toBeTruthy()
    expect(actions.readVersion).toHaveBeenCalledTimes(1)
    scrub(1)
    rerender(<HistoryPanel {...actions} entries={[entries[0], fourth, entries[1], entries[2]]} current={versions.fourth} />)
    expect(screen.getByRole('heading', { name: 'Next draft' })).toBeTruthy()
    expect(screen.getByText('Version 3 of 4')).toBeTruthy()
    expect(actions.restore).not.toHaveBeenCalled()
  })

  it('disables restore for any version matching current content or while locked', () => {
    const actions = props({ current: versions.first })
    const { rerender } = render(<HistoryPanel {...actions} />)
    scrub(0)
    const button = screen.getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    scrub(1)
    expect(button.disabled).toBe(false)
    rerender(<HistoryPanel {...actions} disabled />)
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(actions.restore).not.toHaveBeenCalled()
  })

  it('shows read failures and pauses playback without rendering a stale preview', () => {
    vi.useFakeTimers()
    const actions = props({ readVersion: vi.fn(id => {
      if (id === 'second') throw new Error('Invalid saved version')
      return versions[id]
    }) })
    render(<HistoryPanel {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play history' }))
    tick()
    expect(screen.getByRole('alert').textContent).toContain('This version could not be opened')
    expect(screen.queryByRole('article')).toBeNull()
    expect(screen.getByRole('button', { name: 'Play history' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement).disabled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    scrub(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Current draft' })).toBeTruthy()
    expect(actions.restore).not.toHaveBeenCalled()
  })

  it('uses the safe Markdown renderer for historical content', () => {
    const actions = props({ readVersion: () => ({ title: '<script>title</script>', content: '<script>alert(1)</script>\n\n![Private image](https://example.com/tracker.png)\n\n[Link](https://example.com)' }) })
    const { container } = render(<HistoryPanel {...actions} />)
    expect(screen.getByRole('heading', { name: '<script>title</script>' })).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/remote images are not loaded/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Link' }).getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('cancels playback when closed or unmounted', () => {
    vi.useFakeTimers()
    const actions = props()
    const { unmount } = render(<HistoryPanel {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play history' }))
    expect(vi.getTimerCount()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close history' }))
    expect(actions.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Play history' }))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(actions.restore).not.toHaveBeenCalled()
  })

  it('handles an empty timeline and a single saved version', () => {
    const actions = props({ entries: [] })
    const { rerender } = render(<HistoryPanel {...actions} />)
    expect(screen.getByText('Your saved versions will appear here.')).toBeTruthy()
    expect(screen.queryByRole('slider')).toBeNull()
    expect(actions.readVersion).not.toHaveBeenCalled()
    rerender(<HistoryPanel {...actions} entries={[entries[0]]} />)
    expect(screen.getByText('Version 1 of 1')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Play history' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true)
    rerender(<HistoryPanel {...actions} entries={entries} />)
    expect(screen.getByText('Version 1 of 3')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'First draft' })).toBeTruthy()
  })

  it('shows each editor’s additions and deletions in a collaborative saved version', () => {
    const readChanges = vi.fn(() => ({ baseline: false, edits: [
      { id: 'a1', recordedAt: entries[1].recordedAt, author: { id: 'alice', label: 'Alice' }, changes: [{ field: 'title' as const, deleted: 'Draft title', inserted: 'Shared title' }] },
      { id: 'b1', recordedAt: entries[2].recordedAt, author: { id: 'bob', label: 'Bob' }, changes: [{ field: 'content' as const, deleted: 'Outdated sentence', inserted: 'Revised sentence' }] },
      { id: 'a2', recordedAt: entries[2].recordedAt, author: { id: 'alice', label: 'Alice' }, changes: [{ field: 'content' as const, deleted: '', inserted: 'A final sentence' }] },
    ] }))
    const actions = props({ collaborative: true, readChanges })
    render(<HistoryPanel {...actions} />)
    expect(screen.getByRole('button', { name: 'Changes' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('article', { name: 'Version preview' })).toBeNull()
    const alice = screen.getByRole('region', { name: 'Edits by Alice' })
    const bob = screen.getByRole('region', { name: 'Edits by Bob' })
    expect(within(alice).getByText('Draft title').tagName).toBe('DEL')
    expect(within(alice).getByText('Shared title').tagName).toBe('INS')
    expect(within(alice).getByText('A final sentence').tagName).toBe('INS')
    expect(within(bob).getByText('Outdated sentence').tagName).toBe('DEL')
    expect(within(bob).getByText('Revised sentence').tagName).toBe('INS')
    expect(within(alice).queryByText('Revised sentence')).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Editors in this version' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Alice', 'Bob'])
    expect(readChanges).toHaveBeenCalledExactlyOnceWith('third')
    expect(screen.getByText('Attribution is supplied by editors and is not independently verified.')).toBeTruthy()
    expect(screen.getByText(/Saved versions stay private; edit attribution is shared/)).toBeTruthy()
    expect(actions.restore).not.toHaveBeenCalled()
  })

  it('renders reported names and changed text as inert text and labels unavailable authors', () => {
    const maliciousLabel = '<script>pretend to be Alice</script>'
    const actions = props({ collaborative: true, readChanges: () => ({ baseline: false, edits: [
      { id: 'a1', recordedAt: entries[1].recordedAt, author: { id: 'claimed-id', label: maliciousLabel }, changes: [{ field: 'content', deleted: '<img src=x onerror=alert(1)>', inserted: '[Link](https://example.com)\n<script>alert(1)</script>' }] },
      { id: 'unknown', recordedAt: entries[2].recordedAt, changes: [{ field: 'content', deleted: 'Someone removed this', inserted: '' }] },
    ] }) })
    const { container } = render(<HistoryPanel {...actions} />)
    expect(screen.getByRole('heading', { name: maliciousLabel })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Author unavailable' })).toBeTruthy()
    expect(screen.getByText('<img src=x onerror=alert(1)>').tagName).toBe('DEL')
    expect(container.querySelector('script, img, a')).toBeNull()
    expect(container.querySelector('ins')?.textContent).toBe('[Link](https://example.com)\n<script>alert(1)</script>')
    expect(screen.queryByText('You')).toBeNull()
  })

  it('distinguishes editors who report the same name, including matching short ID suffixes', () => {
    const firstId = 'pubky:1111abcdefghijkl'
    const secondId = 'pubky:2222abcdefghijkl'
    render(<HistoryPanel {...props({ collaborative: true, readChanges: () => ({ baseline: false, edits: [
      { id: 'a1', recordedAt: entries[1].recordedAt, author: { id: firstId, label: 'Alex' }, changes: [{ field: 'content', deleted: '', inserted: 'First editor addition' }] },
      { id: 'a2', recordedAt: entries[2].recordedAt, author: { id: secondId, label: 'Alex' }, changes: [{ field: 'content', deleted: 'Second editor deletion', inserted: '' }] },
      { id: 'a3', recordedAt: entries[2].recordedAt, author: { id: 'pubky:unique', label: 'Sam' }, changes: [{ field: 'title', deleted: '', inserted: 'A title' }] },
    ] }) })} />)
    const first = screen.getByRole('region', { name: 'Edits by Alex · …1111abcdefghijkl' })
    const second = screen.getByRole('region', { name: 'Edits by Alex · …2222abcdefghijkl' })
    expect(within(first).getByText('First editor addition').tagName).toBe('INS')
    expect(within(second).getByText('Second editor deletion').tagName).toBe('DEL')
    expect(within(first).getByRole('heading', { level: 3 }).getAttribute('title')).toBe(firstId)
    expect(within(second).getByRole('heading', { level: 3 }).getAttribute('title')).toBe(secondId)
    expect(screen.getByRole('region', { name: 'Edits by Sam' })).toBeTruthy()
    expect(within(screen.getByRole('list', { name: 'Editors in this version' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Alex · …1111abcdefghijkl', 'Alex · …2222abcdefghijkl', 'Sam'])
  })

  it('labels the shared baseline and allows switching to a read-only preview', () => {
    const actions = props({ collaborative: true, readChanges: () => ({ baseline: true, edits: [] }) })
    render(<HistoryPanel {...actions} />)
    expect(screen.getByRole('heading', { name: 'Shared starting text' })).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Editors in this version' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('article', { name: 'Version preview' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Current draft' })).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }))
    expect(screen.getByRole('heading', { name: 'Shared starting text' })).toBeTruthy()
    expect(actions.restore).not.toHaveBeenCalled()
  })

  it('keeps preview as the default for private notes and describes missing edit records', () => {
    render(<HistoryPanel {...props({ readChanges: () => ({ baseline: false, edits: [] }) })} />)
    expect(screen.getByRole('article', { name: 'Version preview' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }))
    expect(screen.getByText('No recorded attributed edits for this version.')).toBeTruthy()
    expect(screen.queryByText(/Attribution is supplied/)).toBeNull()
  })

  it('pauses on a changes read failure while keeping the preview available', () => {
    vi.useFakeTimers()
    const actions = props({ collaborative: true, readChanges: vi.fn(id => {
      if (id === 'second') throw new Error('Invalid edit history')
      return { baseline: id === 'first', edits: [] }
    }) })
    render(<HistoryPanel {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play history' }))
    tick()
    expect(screen.getByRole('alert').textContent).toContain('Changes for this version could not be opened')
    expect(screen.getByRole('button', { name: 'Play history' })).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Next draft' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
    expect(actions.restore).toHaveBeenCalledExactlyOnceWith('second')
  })
})
