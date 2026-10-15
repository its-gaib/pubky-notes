import { describe, expect, it } from 'vitest'
import { COLLAPSED_SIDEBAR_WIDTH, MIN_EDITOR_WIDTH, SIDEBAR_DEFAULTS, SIDEBAR_LIMITS, fitSidebarLayout, parseSidebarLayout } from './sidebar-layout'

describe('saved sidebar preferences', () => {
  it.each([null, undefined, [], 'wide', 270, true])('uses defaults for malformed settings %s', value => {
    expect(parseSidebarLayout(value)).toEqual(SIDEBAR_DEFAULTS)
  })

  it('preserves the old collapse-only format and ignores unknown keys', () => {
    expect(parseSidebarLayout({ navigationCollapsed: true, notesCollapsed: false, arbitraryStyle: 'position:fixed' })).toEqual({
      ...SIDEBAR_DEFAULTS, navigationCollapsed: true,
    })
    expect(Object.keys(parseSidebarLayout({ unexpected: 42 })).sort()).toEqual(['navigationCollapsed', 'navigationWidth', 'notesCollapsed', 'notesWidth'])
  })

  it('accepts only finite numeric widths and boolean collapse flags', () => {
    for (const value of ['260', {}, [], null, undefined, NaN, Infinity, -Infinity, true]) {
      expect(parseSidebarLayout({ navigationWidth: value, notesWidth: value, navigationCollapsed: value, notesCollapsed: value })).toEqual({
        ...SIDEBAR_DEFAULTS, navigationCollapsed: value === true, notesCollapsed: value === true,
      })
    }
    expect(parseSidebarLayout({ navigationCollapsed: 'true', notesCollapsed: 1 })).toEqual(SIDEBAR_DEFAULTS)
  })

  it('rounds valid widths, clamps them to supported limits, and ignores inherited settings', () => {
    expect(parseSidebarLayout({ navigationWidth: 185.8, notesWidth: 275.1 })).toMatchObject({ navigationWidth: 186, notesWidth: 275 })
    expect(parseSidebarLayout({ navigationWidth: -10, notesWidth: 100_000 })).toMatchObject({ navigationWidth: 160, notesWidth: 480 })
    expect(parseSidebarLayout({ navigationWidth: 100_000, notesWidth: -10 })).toMatchObject({ navigationWidth: 360, notesWidth: 200 })
    expect(parseSidebarLayout(Object.create({ navigationCollapsed: true, navigationWidth: 350 }))).toEqual(SIDEBAR_DEFAULTS)
  })
})

describe('responsive sidebar widths', () => {
  it('keeps preferred widths on a wide desktop and leaves the settings unchanged', () => {
    const preferences = Object.freeze({ ...SIDEBAR_DEFAULTS, navigationWidth: 340, notesWidth: 450 })
    expect(fitSidebarLayout(preferences, 1600)).toEqual({ navigationWidth: 340, notesWidth: 450, navigationMaxWidth: 360, notesMaxWidth: 480 })
    fitSidebarLayout(preferences, 701)
    expect(preferences).toEqual({ ...SIDEBAR_DEFAULTS, navigationWidth: 340, notesWidth: 450 })
    expect(fitSidebarLayout(preferences, 1600).notesWidth).toBe(450)
  })

  it('shares a narrow desktop budget proportionally above each pane minimum', () => {
    const result = fitSidebarLayout({ ...SIDEBAR_DEFAULTS, navigationWidth: 260, notesWidth: 400 }, 860)
    expect(result).toEqual({ navigationWidth: 220, notesWidth: 320, navigationMaxWidth: 220, notesMaxWidth: 320 })
    const smallestDesktop = fitSidebarLayout({ ...SIDEBAR_DEFAULTS, navigationWidth: 360, notesWidth: 480 }, 701)
    expect(smallestDesktop.navigationWidth + smallestDesktop.notesWidth).toBe(381)
    expect(smallestDesktop.navigationWidth).toBeGreaterThanOrEqual(160)
    expect(smallestDesktop.notesWidth).toBeGreaterThanOrEqual(200)
  })

  it('reserves only the arrow footprint for collapsed panes and a single arrow when both are collapsed', () => {
    const maximums = { ...SIDEBAR_DEFAULTS, navigationWidth: 360, notesWidth: 480 }
    expect(fitSidebarLayout({ ...maximums, navigationCollapsed: true }, 701)).toMatchObject({ navigationWidth: 28, notesWidth: 353 })
    expect(fitSidebarLayout({ ...maximums, notesCollapsed: true }, 701)).toMatchObject({ navigationWidth: 353, notesWidth: 28 })
    expect(fitSidebarLayout({ ...maximums, navigationCollapsed: true, notesCollapsed: true }, 701)).toMatchObject({ navigationWidth: COLLAPSED_SIDEBAR_WIDTH, notesWidth: 0 })
  })

  it('keeps valid ordered bounds when a viewport measurement is missing or too small for desktop', () => {
    for (const viewport of [NaN, Infinity, -Infinity, 0, -300, 1, 320]) {
      const result = fitSidebarLayout({ ...SIDEBAR_DEFAULTS }, viewport)
      expect(result.navigationWidth).toBeGreaterThanOrEqual(SIDEBAR_LIMITS.navigation.min)
      expect(result.notesWidth).toBeGreaterThanOrEqual(SIDEBAR_LIMITS.notes.min)
      expect(result.navigationMaxWidth).toBeGreaterThanOrEqual(SIDEBAR_LIMITS.navigation.min)
      expect(result.notesMaxWidth).toBeGreaterThanOrEqual(SIDEBAR_LIMITS.notes.min)
      expect(Object.values(result).every(Number.isFinite)).toBe(true)
    }
  })

  it('never crowds out the editor or reports unusable resize bounds across desktop sizes and collapse combinations', () => {
    for (const viewport of [701, 702.9, 720, 900, 1100, 1440, 2560]) {
      for (const navigationWidth of [160, 174, 250, 360]) {
        for (const notesWidth of [200, 242, 350, 480]) {
          for (const navigationCollapsed of [false, true]) {
            for (const notesCollapsed of [false, true]) {
              const result = fitSidebarLayout({ navigationWidth, notesWidth, navigationCollapsed, notesCollapsed }, viewport)
              expect(result.navigationWidth + result.notesWidth + MIN_EDITOR_WIDTH).toBeLessThanOrEqual(viewport)
              expect(result.navigationMaxWidth).toBeGreaterThanOrEqual(SIDEBAR_LIMITS.navigation.min)
              expect(result.navigationMaxWidth).toBeLessThanOrEqual(SIDEBAR_LIMITS.navigation.max)
              expect(result.notesMaxWidth).toBeGreaterThanOrEqual(SIDEBAR_LIMITS.notes.min)
              expect(result.notesMaxWidth).toBeLessThanOrEqual(SIDEBAR_LIMITS.notes.max)
              if (!navigationCollapsed) expect(result.navigationWidth).toBeLessThanOrEqual(result.navigationMaxWidth)
              if (!notesCollapsed) expect(result.notesWidth).toBeLessThanOrEqual(result.notesMaxWidth)
              expect(Object.values(result).every(Number.isInteger)).toBe(true)
            }
          }
        }
      }
    }
  })
})
