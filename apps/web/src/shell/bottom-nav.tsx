import { useState } from 'react'
import { Menu } from 'lucide-react'
import { NavLink, useLocation } from 'react-router'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { cn } from '@/lib/utils'
import { navItems } from './nav-items'
import { NomeAparelho } from './nome-aparelho'

export function BottomNav() {
  const location = useLocation()
  const [menuAberto, setMenuAberto] = useState(false)
  const menuAtivo = navItems.some((item) => item.mobile === 'menu' && location.pathname === item.to)

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur sm:hidden"
        aria-label="Principal"
      >
        <div className="grid grid-cols-3">
          {navItems
            .filter((item) => item.mobile === 'bar')
            .map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex flex-col items-center gap-1 py-2 text-[10px]',
                    isActive ? 'text-primary' : 'text-muted-foreground',
                  )
                }
              >
                <item.icon className="size-4" />
                {item.label}
              </NavLink>
            ))}
          <button
            type="button"
            className={cn(
              'flex flex-col items-center gap-1 py-2 text-[10px]',
              menuAtivo ? 'text-primary' : 'text-muted-foreground',
            )}
            aria-expanded={menuAberto}
            onClick={() => setMenuAberto(true)}
          >
            <Menu className="size-4" />
            Menu
          </button>
        </div>
      </nav>
      <Drawer open={menuAberto} onOpenChange={setMenuAberto}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-md">
            <DrawerHeader>
              <DrawerTitle>Menu</DrawerTitle>
            </DrawerHeader>
            <div className="grid gap-2 p-4">
              {navItems
                .filter((item) => item.mobile === 'menu')
                .map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'flex h-11 items-center gap-2 rounded-lg px-3 text-sm',
                        isActive ? 'bg-muted text-primary' : 'text-foreground hover:bg-muted',
                      )
                    }
                    onClick={() => setMenuAberto(false)}
                  >
                    <item.icon className="size-4" />
                    {item.label}
                  </NavLink>
                ))}
              <div className="mt-2 border-t pt-3">
                <NomeAparelho />
              </div>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  )
}
