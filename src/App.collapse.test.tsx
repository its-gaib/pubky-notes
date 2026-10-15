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

describe('single sidebar layout controls', () => {
  it('collapses the whole sidebar and restores it with one arrow', async () => {
    await openNotebook()
    expect(screen.getAllByRole('separator')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(document.querySelectorAll('.pane-toggle')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Expand sidebar' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('separator')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(screen.getByRole('button', { name: 'Collapse sidebar' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('separator', { name: 'Resize sidebar' })).toBeTruthy()
  })

  it('retains the collapsed state after a reload and persists reopening it', async () => {
    await openNotebook()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    cleanup()
    await openNotebook()
    expect(document.querySelectorAll('.pane-toggle')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(JSON.parse(localStorage.getItem('pubky-notes:layout')!)).toEqual({ collapsed: false, width: 260 })
  })

  it('has one collapse arrow and no resize handle on mobile', async () => {
    viewport(true)
    await openNotebook()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(document.querySelectorAll('.pane-toggle')).toHaveLength(1)
    const toggle = screen.getByRole('button', { name: /^(Expand|Collapse) sidebar$/ })
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(screen.getByRole('button', { name: 'Collapse sidebar' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('resizes with the keyboard and preserves the width through collapse and reload', async () => {
    await openNotebook()
    const sidebar = screen.getByRole('separator', { name: 'Resize sidebar' })
    fireEvent.keyDown(sidebar, { key: 'ArrowRight' })
    expect(sidebar.getAttribute('aria-valuenow')).toBe('270')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(screen.queryByRole('separator')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(screen.getByRole('separator', { name: 'Resize sidebar' }).getAttribute('aria-valuenow')).toBe('270')
    cleanup()
    await openNotebook()
    expect(screen.getByRole('separator', { name: 'Resize sidebar' }).getAttribute('aria-valuenow')).toBe('270')
  })

  it('allows the wider resize range and supports double-click reset', async () => {
    vi.stubGlobal('innerWidth', 1920)
    await openNotebook()
    const sidebar = screen.getByRole('separator', { name: 'Resize sidebar' })
    fireEvent.keyDown(sidebar, { key: 'Home' })
    fireEvent.keyDown(sidebar, { key: 'ArrowLeft' })
    expect(sidebar.getAttribute('aria-valuenow')).toBe('160')
    fireEvent.keyDown(sidebar, { key: 'End' })
    fireEvent.keyDown(sidebar, { key: 'ArrowRight' })
    expect(sidebar.getAttribute('aria-valuenow')).toBe('900')
    fireEvent.doubleClick(sidebar)
    expect(sidebar.getAttribute('aria-valuenow')).toBe('260')
  })

  it('temporarily fits narrow windows and starts subsequent resizing from the visible width', async () => {
    vi.stubGlobal('innerWidth', 1920)
    localStorage.setItem('pubky-notes:layout', JSON.stringify({ width: 900 }))
    await openNotebook()
    vi.stubGlobal('innerWidth', 800)
    fireEvent(window, new Event('resize'))
    const sidebar = screen.getByRole('separator', { name: 'Resize sidebar' })
    expect(sidebar.getAttribute('aria-valuenow')).toBe('480')
    expect(JSON.parse(localStorage.getItem('pubky-notes:layout')!)).toMatchObject({ width: 900 })
    vi.stubGlobal('innerWidth', 1920)
    fireEvent(window, new Event('resize'))
    expect(sidebar.getAttribute('aria-valuenow')).toBe('900')
    vi.stubGlobal('innerWidth', 800)
    fireEvent(window, new Event('resize'))
    fireEvent.keyDown(sidebar, { key: 'ArrowLeft' })
    expect(sidebar.getAttribute('aria-valuenow')).toBe('470')
    expect(JSON.parse(localStorage.getItem('pubky-notes:layout')!)).toMatchObject({ width: 470 })
  })
})
