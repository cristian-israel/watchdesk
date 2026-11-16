import { FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router'
import { useActionDialog } from '@/actions/action-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, apiOrThrow, type SessionInfo } from '@/lib/api'
import { KEY_MIN, ROOM_RE } from '@/lib/room'
import { Pagina } from '@/shell/pagina'
import { useProfile } from '@/shell/profile'

export function SalasPage() {
  const navigate = useNavigate()
  const action = useActionDialog()
  const { room, refresh } = useProfile()
  const [slug, setSlug] = useState('')
  const [hostKey, setHostKey] = useState('')
  const [viewerKey, setViewerKey] = useState('')
  const [maxViewers, setMaxViewers] = useState(8)

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    const name = slug.trim()
    if (!ROOM_RE.test(name)) {
      action.fail('Nome de sala inválido.')
      return
    }
    if (hostKey.length < KEY_MIN || viewerKey.length < KEY_MIN) {
      action.fail('As chaves precisam ter no mínimo 8 caracteres.')
      return
    }
    await action.run({ pending: 'Criando sala…', success: 'Sala criada' }, async () => {
      await apiOrThrow('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({
          slug: name,
          hostKey,
          viewerKey,
          maxViewers,
        }),
      })
      setSlug('')
      setHostKey('')
      setViewerKey('')
      await refresh()
    })
  }

  async function transmitir() {
    if (!room) return
    await action.run({ pending: 'Entrando…', success: 'Pronto' }, async () => {
      const session = await api<SessionInfo>('/api/session')
      const alreadyHost = session.ok && session.data.role === 'host' && session.data.room === room.slug
      if (!alreadyHost) {
        await apiOrThrow<SessionInfo>(`/api/rooms/${encodeURIComponent(room.slug)}/host`, {
          method: 'POST',
          body: JSON.stringify({}),
        })
      }
      navigate(`/salas/${encodeURIComponent(room.slug)}`)
    })
  }

  async function excluir() {
    if (!room) return
    if (!window.confirm(`Excluir a sala ${room.slug}? Quem estiver nela sai na hora.`)) return
    await action.run({ pending: 'Excluindo…', success: 'Sala excluída' }, async () => {
      await apiOrThrow('/api/me/room', { method: 'DELETE' })
      await refresh()
    })
  }

  async function copiar(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Link copiado')
    } catch {
      toast.error('Não foi possível copiar o link')
    }
  }

  if (room) {
    const convite = `${location.origin}/sala/${room.slug}`
    return (
      <Pagina titulo="Salas" descricao="Este aparelho já tem uma sala. Exclua para criar outra.">
        <Card>
          <CardHeader>
            <CardTitle>{room.slug}</CardTitle>
            <CardDescription>
              {room.active ? 'Sala ativa' : 'Sala desativada'} · máx. {room.maxViewers} espectadores
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="space-y-2">
              <Label htmlFor="convite">Link de convite</Label>
              <div className="flex gap-2">
                <Input id="convite" value={convite} readOnly />
                <Button type="button" variant="outline" onClick={() => void copiar(convite)}>
                  Copiar
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" disabled={action.busy} onClick={() => void transmitir()} className="sm:flex-1">
                Transmitir
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={action.busy}
                onClick={() => void excluir()}
                className="sm:flex-1"
              >
                Excluir
              </Button>
            </div>
          </CardContent>
        </Card>
      </Pagina>
    )
  }

  return (
    <Pagina titulo="Salas" descricao="Uma sala por aparelho. As chaves ficam com você.">
      <Card>
        <CardHeader>
          <CardTitle>Nova sala</CardTitle>
          <CardDescription>Depois de criar, transmita por aqui. Para outra sala, exclua esta.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(e) => void onCreate(e)} autoComplete="off">
            <div className="space-y-2">
              <Label htmlFor="slug">Nome da sala</Label>
              <Input
                id="slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                pattern="[a-zA-Z0-9_-]{1,40}"
                required
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hostKey">Chave do host</Label>
              <Input
                id="hostKey"
                type="password"
                value={hostKey}
                onChange={(e) => setHostKey(e.target.value)}
                minLength={KEY_MIN}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="viewerKey">Chave dos espectadores</Label>
              <Input
                id="viewerKey"
                type="password"
                value={viewerKey}
                onChange={(e) => setViewerKey(e.target.value)}
                minLength={KEY_MIN}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxViewers">Máx. espectadores (1–8)</Label>
              <Input
                id="maxViewers"
                type="number"
                min={1}
                max={8}
                value={maxViewers}
                onChange={(e) => setMaxViewers(Number(e.target.value))}
                required
              />
            </div>
            <Button type="submit" disabled={action.busy} className="w-full">
              Criar sala
            </Button>
          </form>
        </CardContent>
      </Card>
    </Pagina>
  )
}
