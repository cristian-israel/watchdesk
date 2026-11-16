import { create } from 'zustand'
import { APPEARANCE_KEY, applyAppearance, readAppearance, type Appearance, type ResolvedMode } from './appearance'

type AppearanceState = {
  appearance: Appearance
  resolvedMode: ResolvedMode
}

export const useAppearance = create<AppearanceState>(() => {
  const appearance = readAppearance()
  return {
    appearance,
    resolvedMode: applyAppearance(appearance),
  }
})

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')

export function definirAparencia(parcial: Partial<Appearance>) {
  const appearance = { ...useAppearance.getState().appearance, ...parcial }
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance))
  useAppearance.setState({ appearance, resolvedMode: applyAppearance(appearance) })
}

systemTheme.addEventListener('change', () => {
  const { appearance } = useAppearance.getState()

  if (appearance.mode !== 'system') {
    return
  }

  useAppearance.setState({ resolvedMode: applyAppearance(appearance) })
})
