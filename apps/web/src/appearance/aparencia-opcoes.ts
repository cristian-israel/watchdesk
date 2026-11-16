import type { FontName, Mode, ThemeName } from './appearance'

export const modos: { id: Mode; rotulo: string }[] = [
  { id: 'system', rotulo: 'Dispositivo' },
  { id: 'light', rotulo: 'Claro' },
  { id: 'dark', rotulo: 'Escuro' },
]

export const temas: { id: ThemeName; rotulo: string; cores: [string, string, string] }[] = [
  { id: 'default', rotulo: 'Mono', cores: ['#171717', '#737373', '#f5f5f5'] },
  { id: 'ocean', rotulo: 'Oceano', cores: ['#0c4a6e', '#0ea5e9', '#e0f2fe'] },
  { id: 'forest', rotulo: 'Floresta', cores: ['#14532d', '#22c55e', '#dcfce7'] },
  { id: 'amber', rotulo: 'Âmbar', cores: ['#92400e', '#f59e0b', '#fef3c7'] },
  { id: 'slate', rotulo: 'Ardósia', cores: ['#0f172a', '#64748b', '#f1f5f9'] },
  { id: 'rose', rotulo: 'Rosa', cores: ['#9f1239', '#f43f5e', '#ffe4e6'] },
  { id: 'contrast', rotulo: 'Alto contraste', cores: ['#000000', '#ffff00', '#ffffff'] },
]

export const fontes: { id: FontName; rotulo: string; pilha: string }[] = [
  { id: 'comfortaa', rotulo: 'Comfortaa', pilha: "'Comfortaa', ui-rounded, system-ui, sans-serif" },
  { id: 'geist', rotulo: 'Geist', pilha: "'Geist Variable', sans-serif" },
  { id: 'nunito', rotulo: 'Nunito', pilha: "'Nunito', system-ui, sans-serif" },
  { id: 'dm-sans', rotulo: 'DM Sans', pilha: "'DM Sans', system-ui, sans-serif" },
  { id: 'outfit', rotulo: 'Outfit', pilha: "'Outfit', system-ui, sans-serif" },
  { id: 'manrope', rotulo: 'Manrope', pilha: "'Manrope', system-ui, sans-serif" },
  { id: 'space-grotesk', rotulo: 'Space Grotesk', pilha: "'Space Grotesk', system-ui, sans-serif" },
  { id: 'system', rotulo: 'Sistema', pilha: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
]
