import { FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router'
import { useActionDialog } from '@/actions/action-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, apiOrThrow, type SessionInfo } from '@/lib/api'
import { viewerInviteUrl } from '@/lib/room'
import { Pagina } from '@/shell/pagina'
import { useProfile } from '@/shell/profile'

export function SalasPage() {
  const navigate = useNavigate()
  const action = useActionDialog()
  const { room, refresh, displayName } = useProfile()
  const [maxViewers, setMaxViewers] = useState(8)

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    await action.run({ pending: 'Criando sala…', success: 'Sala criada' }, async () => {
      await apiOrThrow('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ maxViewers }),
      })
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
    const convite = viewerInviteUrl(room.slug, room.viewerInvite || '')
    return (
      <Pagina
        titulo="Salas"
        descricao="Para transmitir com controle remoto, use o Companion no PC do agente. Aqui no navegador: convite e painel opcional."
      >
        <Card>
          <CardHeader>
            <CardTitle>{displayName || room.slug}</CardTitle>
            <CardDescription>
              {room.slug} · {room.active ? 'ativa' : 'desativada'} · máx. {room.maxViewers}{' '}
              espectadores
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              Agente: baixe o Companion na página Início — criar sala, convite, transmitir e
              promover ficam no app. Este painel web só se precisar.
            </p>
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
                Abrir painel web
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
    <Pagina
      titulo="Salas"
      descricao="Uma sala por aparelho. Preferência: criar e transmitir pelo Companion; a web é backup/painel."
    >
      <Card>
        <CardHeader>
          <CardTitle>Nova sala</CardTitle>
          <CardDescription>
            Preferível criar no Companion. Aqui também funciona; o link de convite já inclui a chave.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(e) => void onCreate(e)} autoComplete="off">
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
                autoFocus
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
