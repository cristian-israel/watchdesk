import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { fontes } from '@/appearance/aparencia-opcoes'
import { definirAparencia, useAppearance } from '@/appearance/appearance-store'

export function FonteCard() {
  const font = useAppearance((estado) => estado.appearance.font)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fonte</CardTitle>
        <CardDescription>A fonte vale para o aplicativo inteiro.</CardDescription>
      </CardHeader>
      <CardContent>
        <div role="group" aria-label="Fonte" className="flex flex-wrap justify-end gap-2">
          {fontes.map((fonte) => (
            <Button
              key={fonte.id}
              type="button"
              style={{ fontFamily: fonte.pilha }}
              variant={font === fonte.id ? 'default' : 'outline'}
              aria-pressed={font === fonte.id}
              onClick={() => definirAparencia({ font: fonte.id })}
            >
              {fonte.rotulo}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
