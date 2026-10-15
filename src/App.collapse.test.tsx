// @vitest-environment jsdom

import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { IDBFactory } from 'fake-indexeddb'
import { closeLocalNotebook } from './lib/local-notebook'

configure({ asyncUtilTimeout: 3000 })

vi.mock('./lib/pubky', () => ({
  restoreSession: vi.fn().mockResolvedValue(null),
  startSignIn: vi.fn(),
  persistSession: vi.fn(),
  discardSession: vi.fn(),
  signOut: vi.fn(),
}))

function viewport(mobile: boolean) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: mobile,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))
}

async function openNotebook() {
  render(<App />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'Connect Pubky' }) as HTMLButtonElement).disabled).toBe(false))
}

beforeEach(async () => {
  await closeLocalNotebook()
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  vi.stubGlobal('innerWidth', 1280)
  window.history.replaceState(null, '', '/')
  viewport(false)
})

afterEach(async () => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('sidebar collapse controls', () => {
  it('collapses each sidebar independently and restores both with one arrow', async () => {
    await openNotebook()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }))
    expect(screen.getByRole('button', { name: 'Expand navigation' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'Collapse notes' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse notes' }))
    expect(document.querySelectorAll('.pane-toggle')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Expand navigation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Expand notes' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebars' }))
    expect(screen.getByRole('button', { name: 'Collapse navigation' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Collapse notes' }).getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse notes' }))
    expect(screen.getByRole('button', { name: 'Expand notes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Collapse navigation' })).toBeTruthy()
  })

  it('retains the combined collapsed state after a reload and persists expanding both', async () => {
    await openNotebook()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }))
    cleanup()

    await openNotebook()
    expect(document.querySelectorAll('.pane-toggle')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebars' }))
    expect(JSON.parse(localStorage.getItem('pubky-notes:layout')!)).toEqual({ navigationCollapsed: false, notesCollapsed: false, navigationWidth: 174, notesWidth: 242 })
  })

  it('uses the same combined restore control on mobile', async () => {
    viewport(true)
    await openNotebook()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse notes' }))
    expect(document.querySelectorAll('.pane-toggle')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebars' }))
    expect(screen.getByRole('button', { name: 'Collapse navigation' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Collapse notes' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('resizes both sidebars with the keyboard and preserves widths through collapse, combined restore, and reload', async () => {
    await openNotebook()
    const navigation = screen.getByRole('separator', { name: 'Resize navigation' })
    const notes = screen.getByRole('separator', { name: 'Resize notes' })
    fireEvent.keyDown(navigation, { key: 'ArrowRight' })
    fireEvent.keyDown(notes, { key: 'ArrowRight' })
    expect(navigation.getAttribute('aria-valuenow')).toBe('184')
    expect(notes.getAttribute('aria-valuenow')).toBe('252')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }))
    expect(screen.queryByRole('separator', { name: 'Resize navigation' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse notes' }))
    expect(screen.queryByRole('separator')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebars' }))
    expect(screen.getByRole('separator', { name: 'Resize navigation' }).getAttribute('aria-valuenow')).toBe('184')
    expect(screen.getByRole('separator', { name: 'Resize notes' }).getAttribute('aria-valuenow')).toBe('252')
    cleanup()
    await openNotebook()
    expect(screen.getByRole('separator', { name: 'Resize navigation' }).getAttribute('aria-valuenow')).toBe('184')
    expect(screen.getByRole('separator', { name: 'Resize notes' }).getAttribute('aria-valuenow')).toBe('252')
  })

  it('honors keyboard bounds and double-click reset without changing the other pane', async () => {
    await openNotebook()
    const navigation = screen.getByRole('separator', { name: 'Resize navigation' })
    const notes = screen.getByRole('separator', { name: 'Resize notes' })
    fireEvent.keyDown(navigation, { key: 'Home' })
    fireEvent.keyDown(navigation, { key: 'ArrowLeft' })
    expect(navigation.getAttribute('aria-valuenow')).toBe('160')
    fireEvent.keyDown(notes, { key: 'End' })
    fireEvent.keyDown(notes, { key: 'ArrowRight' })
    expect(notes.getAttribute('aria-valuenow')).toBe('480')
    fireEvent.doubleClick(notes)
    expect(notes.getAttribute('aria-valuenow')).toBe('242')
    expect(navigation.getAttribute('aria-valuenow')).toBe('160')
  })

  it('fits narrow windows temporarily, then resizes from the visible widths without moving the other border', async () => {
    localStorage.setItem('pubky-notes:layout', JSON.stringify({ navigationWidth: 360, notesWidth: 480 }))
    await openNotebook()
    vi.stubGlobal('innerWidth', 800)
    fireEvent(window, new Event('resize'))
    const navigation = screen.getByRole('separator', { name: 'Resize navigation' })
    const notes = screen.getByRole('separator', { name: 'Resize notes' })
    const fittedNavigation = Number(navigation.getAttribute('aria-valuenow'))
    const fittedNotes = Number(notes.getAttribute('aria-valuenow'))
    expect(fittedNavigation + fittedNotes).toBeLessThanOrEqual(480)
    expect(JSON.parse(localStorage.getItem('pubky-notes:layout')!)).toMatchObject({ navigationWidth: 360, notesWidth: 480 })
    vi.stubGlobal('innerWidth', 1280)
    fireEvent(window, new Event('resize'))
    expect(navigation.getAttribute('aria-valuenow')).toBe('360')
    expect(notes.getAttribute('aria-valuenow')).toBe('480')
    vi.stubGlobal('innerWidth', 800)
    fireEvent(window, new Event('resize'))
    fireEvent.keyDown(navigation, { key: 'ArrowLeft' })
    expect(Number(navigation.getAttribute('aria-valuenow'))).toBe(fittedNavigation - 10)
    expect(Number(notes.getAttribute('aria-valuenow'))).toBe(fittedNotes)
    expect(JSON.parse(localStorage.getItem('pubky-notes:layout')!)).toMatchObject({ navigationWidth: fittedNavigation - 10, notesWidth: fittedNotes })
  })
})
