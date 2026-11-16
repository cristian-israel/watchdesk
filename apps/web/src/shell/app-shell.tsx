import { FormEvent, useState, type ReactNode } from 'react'
import { PanelLeft, PanelLeftClose } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { BottomNav } from './bottom-nav'
import { NomeAparelho } from './nome-aparelho'
import { useProfile } from './profile'
import { SideNav } from './side-nav'

export function AppShell({ children }: { children: ReactNode }) {
  const { ready, displayName, error, refresh, saveName } = useProfile()
  const [recolhida, setRecolhida] = useState(false)

  return (
    <div className="flex h-svh overflow-hidden bg-muted/30">
      <aside
        className={cn(
          'hidden h-full shrink-0 overflow-hidden transition-[width,opacity] duration-200 sm:block',
          recolhida ? 'w-0 opacity-0' : 'w-[260px] opacity-100',
        )}
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
      <div className="flex min-w-0 flex-1 p-0 sm:p-2">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background sm:rounded-xl sm:border sm:shadow-sm">
          <header className="hidden h-14 shrink-0 items-center px-4 sm:flex">
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
          <div className="flex min-h-0 flex-1 flex-col">
            {!ready ? (
              <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
                Carregando…
              </div>
            ) : error && !displayName ? (
              <div className="flex h-full items-center justify-center p-4 pb-20 sm:pb-0">
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
            ) : !displayName ? (
              <NomeGate saveName={saveName} />
            ) : (
              children
            )}
          </div>
        </div>
      </div>
      <BottomNav />
    </div>
  )
}

function NomeGate({ saveName }: { saveName: (name: string) => Promise<string | null> }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const message = await saveName(value)
    setBusy(false)
    if (message) setError(message)
  }

  return (
    <div className="flex h-full min-h-0 items-center justify-center p-4 pb-20 sm:pb-0">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Como podemos te chamar?</CardTitle>
          <CardDescription>Esse nome aparece no chat e nas salas.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)} autoComplete="off">
            <div className="space-y-2">
              <Label htmlFor="nome">Seu nome</Label>
              <Input
                id="nome"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                maxLength={80}
                required
                autoFocus
              />
            </div>
            <Button type="submit" disabled={busy} className="w-full">
              Continuar
            </Button>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
