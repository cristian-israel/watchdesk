import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function HomePage() {
  const navigate = useNavigate()
  const [room, setRoom] = useState('')
  const [mode, setMode] = useState<'sala' | 'host'>('sala')

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const id = room.trim()
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) return
    navigate(`/${mode}/${id}`)
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sala de tela</CardTitle>
          <CardDescription>
            Entre como espectador ou abra o painel do host para transmitir.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit} autoComplete="off">
            <div className="flex gap-2">
              <Button
                type="button"
                variant={mode === 'sala' ? 'default' : 'outline'}
                className="flex-1"
                onClick={() => setMode('sala')}
              >
                Assistir
              </Button>
              <Button
                type="button"
                variant={mode === 'host' ? 'default' : 'outline'}
                className="flex-1"
                onClick={() => setMode('host')}
              >
                Transmitir
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="room">Nome da sala</Label>
              <Input
                id="room"
                value={room}
                onChange={(e) => setRoom(e.target.value)}
                placeholder="ex: casa"
                pattern="[a-zA-Z0-9_-]{1,40}"
                required
                autoFocus
              />
            </div>
            <Button type="submit" className="w-full">
              Continuar
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
