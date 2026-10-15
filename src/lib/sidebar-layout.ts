export interface SidebarLayout {
  collapsed: boolean
  width: number
}

export const MIN_EDITOR_WIDTH = 320
export const COLLAPSED_SIDEBAR_WIDTH = 28
export const SIDEBAR_LIMITS = { min: 160, max: 900, default: 260 } as const
export const SIDEBAR_DEFAULTS: Readonly<SidebarLayout> = {
  collapsed: false,
  width: SIDEBAR_LIMITS.default,
}

function validWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Validate device preferences and migrate the former two-sidebar settings. */
export function parseSidebarLayout(value: unknown): SidebarLayout {
  const settings = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  const own = (key: string): unknown => Object.hasOwn(settings, key) ? settings[key] : undefined
  const preferred = [own('width'), own('notesWidth'), own('navigationWidth')].find(validWidth)
  return {
    collapsed: typeof own('collapsed') === 'boolean' ? own('collapsed') === true
      : own('navigationCollapsed') === true && own('notesCollapsed') === true,
    width: preferred === undefined ? SIDEBAR_LIMITS.default
      : Math.max(SIDEBAR_LIMITS.min, Math.min(SIDEBAR_LIMITS.max, Math.round(preferred))),
  }
}

export interface FittedSidebarLayout {
  width: number
  maxWidth: number
}

/** Fit the sidebar while retaining its preferred width for wider windows. */
export function fitSidebarLayout(layout: SidebarLayout, viewportWidth: number): FittedSidebarLayout {
  const preferred = parseSidebarLayout(layout)
  const viewport = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? Math.floor(viewportWidth) : preferred.width + MIN_EDITOR_WIDTH
  const maxWidth = Math.max(SIDEBAR_LIMITS.min, Math.min(SIDEBAR_LIMITS.max, viewport - MIN_EDITOR_WIDTH))
  return {
    width: preferred.collapsed ? COLLAPSED_SIDEBAR_WIDTH : Math.min(preferred.width, maxWidth),
    maxWidth,
  }
}
