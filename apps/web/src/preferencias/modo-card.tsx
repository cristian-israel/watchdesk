import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { modos } from '@/appearance/aparencia-opcoes'
import { definirAparencia, useAppearance } from '@/appearance/appearance-store'

export function ModoCard() {
  const { appearance, resolvedMode } = useAppearance()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Modo</CardTitle>
        <CardDescription>Dispositivo segue o claro ou o escuro do aparelho.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div role="group" aria-label="Modo" className="flex flex-wrap justify-end gap-2">
          {modos.map((modo) => (
            <Button
              key={modo.id}
              type="button"
              variant={appearance.mode === modo.id ? 'default' : 'outline'}
              aria-pressed={appearance.mode === modo.id}
              onClick={() => definirAparencia({ mode: modo.id })}
            >
              {modo.rotulo}
            </Button>
          ))}
        </div>
        {appearance.mode === 'system' ? (
          <p className="text-sm text-muted-foreground">Agora: {resolvedMode === 'dark' ? 'escuro' : 'claro'}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}
