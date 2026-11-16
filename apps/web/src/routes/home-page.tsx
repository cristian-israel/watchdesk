import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Pagina } from '@/shell/pagina'

export function HomePage() {
  const navigate = useNavigate()
  const [room, setRoom] = useState('')

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const id = room.trim()
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) return
    navigate(`/sala/${id}`)
  }

  return (
    <Pagina titulo="Watchdesk" descricao="Assista uma sala. Seu nome fica neste aparelho.">
      <Card>
        <CardHeader>
          <CardTitle>Assistir</CardTitle>
          <CardDescription>Informe o nome da sala.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit} autoComplete="off">
            <div className="space-y-2">
              <Label htmlFor="room">Nome da sala</Label>
              <Input
                id="room"
                value={room}
                onChange={(e) => setRoom(e.target.value)}
                placeholder="ex: apresentacao1"
                pattern="[a-zA-Z0-9_-]{1,40}"
                required
                autoFocus
              />
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
