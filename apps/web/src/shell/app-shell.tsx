import { useState, type ReactNode } from 'react'
import { PanelLeft, PanelLeftClose } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { BottomNav } from './bottom-nav'
import { NomeAparelho } from './nome-aparelho'
import { NomeGate } from './nome-gate'
import { useProfile } from './profile'
import { useShellMode } from './shell-mode'
import { SideNav } from './side-nav'

export function AppShell({ children }: { children: ReactNode }) {
  const { ready, displayName, error, refresh, saveName } = useProfile()
  const { immersive } = useShellMode()
  const [recolhida, setRecolhida] = useState(false)

  if (!ready) {
    return (
      <div className="flex h-svh items-center justify-center bg-background p-4 text-sm text-muted-foreground">
        Carregando…
      </div>
    )
  }

  if (error && !displayName) {
    return (
      <div className="flex h-svh items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Não foi possível entrar</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" onClick={() => void refresh()}>
              Tentar de novo
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!displayName) {
    return <NomeGate saveName={saveName} />
  }

  // Chrome fica na árvore (só some via CSS). Trocar de branch remountava a rota
  // e gerava loop de /api/session + WS fechando antes de conectar.
  return (
    <div className={cn('flex h-svh overflow-hidden', immersive ? 'bg-background' : 'bg-muted/30')}>
      <aside
        className={cn(
          'h-full shrink-0 overflow-hidden transition-[width,opacity] duration-200',
          immersive ? 'hidden' : 'hidden sm:block',
          !immersive && (recolhida ? 'w-0 opacity-0' : 'w-[260px] opacity-100'),
        )}
        aria-hidden={immersive || undefined}
      >
        <div className="flex h-full w-[260px] flex-col gap-4 p-3">
          <div className="flex items-center gap-2.5 px-2">
            <span className="font-heading text-lg font-semibold tracking-tight">Watchdesk</span>
          </div>
          <SideNav />
          <div className="mt-auto">
            <NomeAparelho />
          </div>
        </div>
      </aside>
      <div className={cn('flex min-w-0 flex-1', immersive ? 'p-0' : 'p-0 sm:p-2')}>
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col bg-background',
            !immersive && 'sm:rounded-xl sm:border sm:shadow-sm',
          )}
        >
          <header
            className={cn(
              'h-14 shrink-0 items-center px-4',
              immersive ? 'hidden' : 'hidden sm:flex',
            )}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Alternar menu"
              onClick={() => setRecolhida((atual) => !atual)}
            >
              {recolhida ? <PanelLeft /> : <PanelLeftClose />}
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </div>
      </div>
      <div className={immersive ? 'hidden' : undefined} aria-hidden={immersive || undefined}>
        <BottomNav />
      </div>
    </div>
  )
}
