export interface SidebarLayout {
  navigationCollapsed: boolean
  notesCollapsed: boolean
  navigationWidth: number
  notesWidth: number
}

export const MIN_EDITOR_WIDTH = 320
export const COLLAPSED_SIDEBAR_WIDTH = 28
export const SIDEBAR_LIMITS = {
  navigation: { min: 160, max: 360, default: 174 },
  notes: { min: 200, max: 480, default: 242 },
} as const

export const SIDEBAR_DEFAULTS: Readonly<SidebarLayout> = {
  navigationCollapsed: false,
  notesCollapsed: false,
  navigationWidth: SIDEBAR_LIMITS.navigation.default,
  notesWidth: SIDEBAR_LIMITS.notes.default,
}

function parseWidth(value: unknown, limits: { min: number; max: number; default: number }) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(limits.min, Math.min(limits.max, Math.round(value)))
    : limits.default
}

/** Read only known, correctly typed settings, including the original collapse-only format. */
export function parseSidebarLayout(value: unknown): SidebarLayout {
  const settings = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  const own = (key: string): unknown => Object.hasOwn(settings, key) ? settings[key] : undefined
  return {
    navigationCollapsed: own('navigationCollapsed') === true,
    notesCollapsed: own('notesCollapsed') === true,
    navigationWidth: parseWidth(own('navigationWidth'), SIDEBAR_LIMITS.navigation),
    notesWidth: parseWidth(own('notesWidth'), SIDEBAR_LIMITS.notes),
  }
}

export interface FittedSidebarLayout {
  navigationWidth: number
  notesWidth: number
  navigationMaxWidth: number
  notesMaxWidth: number
}

/**
 * Fit desktop panes without changing the user's saved width preferences. Each
 * expanded pane gives up the same proportion of the space above its minimum.
 * Mobile uses its own layout; below the desktop minimum these widths stay usable.
 */
export function fitSidebarLayout(layout: SidebarLayout, viewportWidth: number): FittedSidebarLayout {
  const preferred = parseSidebarLayout(layout)
  const navigationMinimum = preferred.navigationCollapsed ? COLLAPSED_SIDEBAR_WIDTH : SIDEBAR_LIMITS.navigation.min
  const notesMinimum = preferred.notesCollapsed
    ? preferred.navigationCollapsed ? 0 : COLLAPSED_SIDEBAR_WIDTH
    : SIDEBAR_LIMITS.notes.min
  let navigationWidth = preferred.navigationCollapsed ? navigationMinimum : preferred.navigationWidth
  let notesWidth = preferred.notesCollapsed ? notesMinimum : preferred.notesWidth
  const viewport = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? Math.floor(viewportWidth) : navigationWidth + notesWidth + MIN_EDITOR_WIDTH
  const budget = Math.max(navigationMinimum + notesMinimum, viewport - MIN_EDITOR_WIDTH)
  const navigationExtra = navigationWidth - navigationMinimum
  const notesExtra = notesWidth - notesMinimum
  const totalExtra = navigationExtra + notesExtra

  if (navigationWidth + notesWidth > budget && totalExtra > 0) {
    const availableExtra = budget - navigationMinimum - notesMinimum
    navigationWidth = navigationMinimum + Math.round(availableExtra * navigationExtra / totalExtra)
    notesWidth = notesMinimum + availableExtra - (navigationWidth - navigationMinimum)
  }

  return {
    navigationWidth,
    notesWidth,
    navigationMaxWidth: Math.max(SIDEBAR_LIMITS.navigation.min, Math.min(SIDEBAR_LIMITS.navigation.max, viewport - MIN_EDITOR_WIDTH - notesWidth)),
    notesMaxWidth: Math.max(SIDEBAR_LIMITS.notes.min, Math.min(SIDEBAR_LIMITS.notes.max, viewport - MIN_EDITOR_WIDTH - navigationWidth)),
  }
}
