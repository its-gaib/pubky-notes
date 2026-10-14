// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

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

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  viewport(false)
})

afterEach(() => {
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
    expect(JSON.parse(localStorage.getItem('pubky-notes:layout')!)).toEqual({ navigationCollapsed: false, notesCollapsed: false })
  })

  it('uses the same combined restore control on mobile', async () => {
    viewport(true)
    await openNotebook()
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse notes' }))
    expect(document.querySelectorAll('.pane-toggle')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebars' }))
    expect(screen.getByRole('button', { name: 'Collapse navigation' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Collapse notes' }).getAttribute('aria-expanded')).toBe('true')
  })
})
