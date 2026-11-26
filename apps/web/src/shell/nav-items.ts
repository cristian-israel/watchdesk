import type { LucideIcon } from 'lucide-react'
import { DoorOpen, Home, Palette, Users } from 'lucide-react'

export type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  mobile: 'bar' | 'menu'
  adminOnly?: boolean
  authOnly?: boolean
}

export const navItems: NavItem[] = [
  { to: '/', label: 'Início', icon: Home, mobile: 'bar' },
  { to: '/salas', label: 'Salas', icon: DoorOpen, mobile: 'bar', authOnly: true },
  { to: '/admin/usuarios', label: 'Usuários', icon: Users, mobile: 'menu', adminOnly: true },
  { to: '/preferencias', label: 'Preferências', icon: Palette, mobile: 'menu' },
]
