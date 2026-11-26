import { NavLink } from 'react-router'
import { cn } from '@/lib/utils'
import { navItems } from './nav-items'
import { useProfile } from './profile'

export function SideNav() {
  const { user } = useProfile()
  const items = navItems.filter((item) => {
    if (item.adminOnly && user?.role !== 'admin') return false
    if (item.authOnly && !user) return false
    return true
  })
  return (
    <nav className="grid gap-1" aria-label="Principal">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-sm',
              isActive ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:bg-muted',
            )
          }
        >
          <item.icon className="size-4" />
          <span className="min-w-0 flex-1">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
