import type { LucideIcon } from 'lucide-react'
import { DoorOpen, Home, Palette } from 'lucide-react'

export type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  mobile: 'bar' | 'menu'
}

export const navItems: NavItem[] = [
  { to: '/', label: 'Início', icon: Home, mobile: 'bar' },
  { to: '/salas', label: 'Salas', icon: DoorOpen, mobile: 'bar' },
  { to: '/preferencias', label: 'Preferências', icon: Palette, mobile: 'menu' },
]
