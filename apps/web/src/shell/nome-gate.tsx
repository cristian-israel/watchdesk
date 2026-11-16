import { FormEvent, useState } from 'react'
import { useActionDialog } from '@/actions/action-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function NomeGate({ saveName }: { saveName: (name: string) => Promise<string | null> }) {
  const action = useActionDialog()
  const [value, setValue] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const name = value.trim()
    if (!name) {
      action.fail('Informe seu nome.')
      return
    }
    await action.run({ pending: 'Salvando…', success: 'Pronto' }, async () => {
      const message = await saveName(name)
      if (message) throw new Error(message)
    })
  }

  return (
    <div className="flex h-svh items-center justify-center bg-background p-4">
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
            <Button type="submit" disabled={action.busy} className="w-full">
              Continuar
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
