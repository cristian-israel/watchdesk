export const APPEARANCE_KEY = 'appearance'

export const modes = ['system', 'light', 'dark'] as const
export const themes = ['default', 'ocean', 'forest', 'amber', 'slate', 'rose', 'contrast'] as const
export const fonts = [
  'comfortaa',
  'geist',
  'nunito',
  'dm-sans',
  'outfit',
  'manrope',
  'space-grotesk',
  'system',
] as const

export type Mode = (typeof modes)[number]
export type ThemeName = (typeof themes)[number]
export type FontName = (typeof fonts)[number]
export type ResolvedMode = 'light' | 'dark'

export type Appearance = {
  mode: Mode
  theme: ThemeName
  font: FontName
}

export const defaultAppearance: Appearance = {
  mode: 'system',
  theme: 'default',
  font: 'comfortaa',
}

const legacyThemes: Record<string, ThemeName> = {
  mono: 'default',
  azul: 'ocean',
  verde: 'forest',
  ambar: 'amber',
}

export const themeBarColors: Record<ThemeName, Record<ResolvedMode, string>> = {
  default: { light: '#ffffff', dark: '#12110e' },
  ocean: { light: '#e0f2fe', dark: '#082f49' },
  forest: { light: '#dcfce7', dark: '#052e16' },
  amber: { light: '#fef3c7', dark: '#451a03' },
  slate: { light: '#f1f5f9', dark: '#020617' },
  rose: { light: '#ffe4e6', dark: '#4c0519' },
  contrast: { light: '#ffffff', dark: '#000000' },
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && options.includes(value as T)
}

export function parseAppearance(value: unknown): Appearance {
  if (!value || typeof value !== 'object') {
    return defaultAppearance
  }

  const raw = value as Record<string, unknown>
  const legacy = typeof raw.theme === 'string' ? legacyThemes[raw.theme] : undefined
  const theme = legacy ?? raw.theme

  return {
    mode: isOneOf(raw.mode, modes) ? raw.mode : defaultAppearance.mode,
    theme: isOneOf(theme, themes) ? theme : defaultAppearance.theme,
    font: isOneOf(raw.font, fonts) ? raw.font : defaultAppearance.font,
  }
}

export function readAppearance(): Appearance {
  try {
    return parseAppearance(JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? 'null'))
  } catch {
    return defaultAppearance
  }
}

export function resolveMode(mode: Mode): ResolvedMode {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  return mode
}

export function applyAppearance(appearance: Appearance): ResolvedMode {
  const resolved = resolveMode(appearance.mode)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.dataset.theme = appearance.theme
  root.dataset.font = appearance.font
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', themeBarColors[appearance.theme][resolved])
  return resolved
}
