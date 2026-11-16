import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { temas } from '@/appearance/aparencia-opcoes'
import { definirAparencia, useAppearance } from '@/appearance/appearance-store'

export function TemaCard() {
  const theme = useAppearance((estado) => estado.appearance.theme)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tema</CardTitle>
        <CardDescription>Mono é o cinza padrão. Os outros trocam o neutro e a cor principal.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {temas.map((item) => {
            const [texto, principal, fundo] = item.cores
            const selecionado = theme === item.id

            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={selecionado}
                className={cn(
                  'grid gap-2 rounded-lg border p-2 text-left',
                  selecionado ? 'border-foreground' : 'border-border hover:bg-muted',
                )}
                onClick={() => definirAparencia({ theme: item.id })}
              >
                <span
                  className="flex h-16 items-end justify-between rounded-md px-3 py-2"
                  style={{ background: fundo, color: texto }}
                >
                  <span className="text-lg font-semibold">Aa</span>
                  <span className="h-1.5 w-8 rounded-full" style={{ background: principal }} />
                </span>
                <span className="text-sm">{item.rotulo}</span>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
