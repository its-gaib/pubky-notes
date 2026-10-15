import { describe, expect, it } from 'vitest'
import { COLLAPSED_SIDEBAR_WIDTH, MIN_EDITOR_WIDTH, SIDEBAR_DEFAULTS, SIDEBAR_LIMITS, fitSidebarLayout, parseSidebarLayout } from './sidebar-layout'

describe('saved sidebar preferences', () => {
  it.each([null, undefined, [], 'wide', 270, true])('uses defaults for malformed settings %s', value => {
    expect(parseSidebarLayout(value)).toEqual(SIDEBAR_DEFAULTS)
  })

  it('migrates the old two-sidebar settings without hiding the remaining sidebar unexpectedly', () => {
    expect(parseSidebarLayout({ navigationCollapsed: true, notesCollapsed: false, notesWidth: 320, navigationWidth: 180 })).toEqual({ collapsed: false, width: 320 })
    expect(parseSidebarLayout({ navigationCollapsed: true, notesCollapsed: true, navigationWidth: 180 })).toEqual({ collapsed: true, width: 180 })
    expect(parseSidebarLayout({ notesCollapsed: true })).toEqual(SIDEBAR_DEFAULTS)
    expect(parseSidebarLayout({ notesWidth: 'wide', navigationWidth: 420 })).toEqual({ collapsed: false, width: 420 })
  })

  it('prefers valid single-sidebar settings and ignores unknown or inherited properties', () => {
    expect(parseSidebarLayout({ collapsed: false, width: 500, navigationCollapsed: true, notesCollapsed: true, notesWidth: 320, arbitraryStyle: 'position:fixed' })).toEqual({ collapsed: false, width: 500 })
    expect(Object.keys(parseSidebarLayout({ unexpected: 42 })).sort()).toEqual(['collapsed', 'width'])
    expect(parseSidebarLayout(Object.create({ collapsed: true, width: 350, notesWidth: 400 }))).toEqual(SIDEBAR_DEFAULTS)
  })

  it('accepts only finite numeric widths and boolean collapse flags', () => {
    for (const value of ['260', {}, [], null, undefined, NaN, Infinity, -Infinity, true]) {
      expect(parseSidebarLayout({ width: value, collapsed: value })).toEqual({
        ...SIDEBAR_DEFAULTS, collapsed: value === true,
      })
    }
    expect(parseSidebarLayout({ collapsed: 'true' })).toEqual(SIDEBAR_DEFAULTS)
    expect(parseSidebarLayout({ collapsed: 1 })).toEqual(SIDEBAR_DEFAULTS)
  })

  it('rounds valid widths and clamps them to the expanded range', () => {
    expect(parseSidebarLayout({ width: 275.8 })).toEqual({ collapsed: false, width: 276 })
    expect(parseSidebarLayout({ width: -10 })).toEqual({ collapsed: false, width: 160 })
    expect(parseSidebarLayout({ width: 100_000 })).toEqual({ collapsed: false, width: 900 })
  })
})

describe('responsive sidebar width', () => {
  it('keeps a wide preference without changing it when the window temporarily narrows', () => {
    const preferences = Object.freeze({ collapsed: false, width: 880 })
    expect(fitSidebarLayout(preferences, 1920)).toEqual({ width: 880, maxWidth: 900 })
    expect(fitSidebarLayout(preferences, 701)).toEqual({ width: 381, maxWidth: 381 })
    expect(preferences).toEqual({ collapsed: false, width: 880 })
    expect(fitSidebarLayout(preferences, 1920).width).toBe(880)
  })

  it('reserves the minimum editor width while allowing the sidebar the remaining space', () => {
    expect(fitSidebarLayout({ collapsed: false, width: 900 }, 860)).toEqual({ width: 540, maxWidth: 540 })
    expect(fitSidebarLayout({ collapsed: false, width: 260 }, 860)).toEqual({ width: 260, maxWidth: 540 })
  })

  it('reserves only one arrow footprint when collapsed', () => {
    expect(fitSidebarLayout({ collapsed: true, width: 900 }, 701)).toEqual({ width: COLLAPSED_SIDEBAR_WIDTH, maxWidth: 381 })
  })

  it('keeps finite ordered bounds when the viewport measurement is missing or too small for desktop', () => {
    for (const viewport of [NaN, Infinity, -Infinity, 0, -300, 1, 320]) {
      const result = fitSidebarLayout({ ...SIDEBAR_DEFAULTS }, viewport)
      expect(result.width).toBeGreaterThanOrEqual(SIDEBAR_LIMITS.min)
      expect(result.maxWidth).toBeGreaterThanOrEqual(SIDEBAR_LIMITS.min)
      expect(result.width).toBeLessThanOrEqual(result.maxWidth)
      expect(Object.values(result).every(Number.isFinite)).toBe(true)
    }
  })

  it('never crowds out the editor or reports unusable resize bounds across desktop sizes and collapse states', () => {
    for (const viewport of [701, 702.9, 720, 900, 1100, 1440, 2560]) {
      for (const width of [160, 260, 480, 600, 900]) {
        for (const collapsed of [false, true]) {
          const result = fitSidebarLayout({ width, collapsed }, viewport)
          expect(result.width + MIN_EDITOR_WIDTH).toBeLessThanOrEqual(viewport)
          expect(result.maxWidth).toBeGreaterThanOrEqual(SIDEBAR_LIMITS.min)
          expect(result.maxWidth).toBeLessThanOrEqual(SIDEBAR_LIMITS.max)
          expect(result.width).toBeLessThanOrEqual(result.maxWidth)
          expect(Object.values(result).every(Number.isInteger)).toBe(true)
        }
      }
    }
  })
})
