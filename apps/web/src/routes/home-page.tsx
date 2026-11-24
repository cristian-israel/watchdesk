import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseInviteInput, viewerInviteUrl } from '@/lib/room'
import { Pagina } from '@/shell/pagina'

export function HomePage() {
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [erro, setErro] = useState('')

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const parsed = parseInviteInput(input)
    if (!parsed) {
      setErro('Cole o link de convite ou o id da sala.')
      return
    }
    setErro('')
    const target = viewerInviteUrl(parsed.slug, parsed.key)
    const url = new URL(target)
    navigate(`${url.pathname}${url.hash}`)
  }

  return (
    <Pagina titulo="Início" descricao="Assista com o link de convite. Seu nome fica neste aparelho.">
      <Card>
        <CardHeader>
          <CardTitle>Assistir</CardTitle>
          <CardDescription>Cole o link completo (já entra com a chave) ou só o id da sala.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit} autoComplete="off">
            <div className="space-y-2">
              <Label htmlFor="invite">Link ou id</Label>
              <Input
                id="invite"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="https://…/sala/…#k=…"
                required
                autoFocus
              />
              {erro ? <p className="text-sm text-destructive">{erro}</p> : null}
            </div>
            <Button type="submit" className="w-full">
              Assistir
            </Button>
          </form>
        </CardContent>
      </Card>
    </Pagina>
  )
}
