import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Navigate, useNavigate } from 'react-router'
import { useActionDialog } from '@/actions/action-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  apiOrThrow,
  formatRemaining,
  roomProgress,
  type DeviceRoom,
  type SessionInfo,
} from '@/lib/api'
import { viewerInviteUrl } from '@/lib/room'
import { Pagina } from '@/shell/pagina'
import { useProfile } from '@/shell/profile'

export function SalasPage() {
  const navigate = useNavigate()
  const action = useActionDialog()
  const { rooms, refresh, displayName, user, slots } = useProfile()
  const [joinMode, setJoinMode] = useState<'ask' | 'open'>('open')
  const [voiceEnabled, setVoiceEnabled] = useState(true)
  const [ttlMinutes, setTtlMinutes] = useState(10)
  const [tick, setTick] = useState(0)
  const [history, setHistory] = useState<DeviceRoom[]>([])

  useEffect(() => {
    if (!rooms.length) return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [rooms.length])

  useEffect(() => {
    if (user?.role !== 'admin') {
      setHistory([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const data = await apiOrThrow<{ rooms: DeviceRoom[]; history: DeviceRoom[] }>('/api/rooms')
        if (!cancelled) setHistory(data.history || [])
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user, rooms])

  if (!user) {
    return <Navigate to="/" replace />
  }

  async function novaSala() {
    await action.run({ pending: 'Criando…', success: 'Sala criada' }, async () => {
      const created = await apiOrThrow<SessionInfo>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ joinMode, voiceEnabled, ttlMinutes }),
      })
      await refresh()
      navigate(`/salas/${encodeURIComponent(created.room)}`)
    })
  }

  async function entrarComoControlador(slug: string) {
    await action.run({ pending: 'Entrando…', success: 'Pronto' }, async () => {
      await apiOrThrow<SessionInfo>(`/api/rooms/${encodeURIComponent(slug)}/join`, {
        method: 'POST',
        body: JSON.stringify({ role: 'controller' }),
      })
      navigate(`/salas/${encodeURIComponent(slug)}`)
    })
  }

  async function encerrar(slug: string) {
    if (!window.confirm(`Encerrar a sala ${slug}? Não dá para reabrir.`)) return
    await action.run({ pending: 'Encerrando…', success: 'Sala encerrada' }, async () => {
      await apiOrThrow(`/api/rooms/${encodeURIComponent(slug)}/end`, {
        method: 'POST',
        body: '{}',
      })
      await refresh()
    })
  }

  async function estender(slug: string) {
    await action.run({ pending: 'Estendendo…', success: 'Tempo atualizado' }, async () => {
      await apiOrThrow(`/api/rooms/${encodeURIComponent(slug)}/extend`, {
        method: 'POST',
        body: JSON.stringify({ minutes: 30 }),
      })
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

  const canCreate = slots.used < slots.max

  return (
    <Pagina
      titulo="Salas"
      descricao={`Slots ${slots.used}/${slots.max}. TTL 5 min–24 h. Capacidade ${
        user.role === 'admin' ? 20 : 10
      } (inclui controlador).`}
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Nova sala</CardTitle>
            <CardDescription>
              {displayName
                ? `Como ${displayName}. Padrão: pública, voz ligada, 10 minutos.`
                : 'Defina seu apelido no perfil.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                variant={joinMode === 'ask' ? 'default' : 'outline'}
                className="sm:flex-1"
                onClick={() => setJoinMode('ask')}
              >
                Pedir para entrar
              </Button>
              <Button
                type="button"
                variant={joinMode === 'open' ? 'default' : 'outline'}
                className="sm:flex-1"
                onClick={() => setJoinMode('open')}
              >
                Público (link basta)
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={voiceEnabled}
                onChange={(e) => setVoiceEnabled(e.target.checked)}
                className="size-4 rounded border border-input"
              />
              Voz da sala
            </label>
            <div className="space-y-2">
              <Label htmlFor="ttl">Expiração (minutos)</Label>
              <Input
                id="ttl"
                type="number"
                min={5}
                max={1440}
                value={ttlMinutes}
                onChange={(e) => setTtlMinutes(Number(e.target.value) || 10)}
              />
            </div>
            <Button
              type="button"
              disabled={action.busy || !displayName || !canCreate}
              onClick={() => void novaSala()}
            >
              {canCreate ? 'Criar sala' : 'Sem slots livres'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ativas</CardTitle>
            <CardDescription>Tempo restante e ações. Expirada não reabre.</CardDescription>
          </CardHeader>
          <CardContent>
            {!rooms.length ? (
              <p className="text-sm text-muted-foreground">Nenhuma sala ativa.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {rooms.map((room) => {
                  const convite = viewerInviteUrl(room.slug)
                  const prog = roomProgress(room)
                  void tick
                  return (
                    <li
                      key={room.slug}
                      className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium">{room.slug}</p>
                          <p className="text-sm text-muted-foreground">
                            {room.joinMode === 'open' ? 'pública' : 'com aceite'}
                            {room.voiceEnabled ? ' · voz' : ''} · cap. {room.capacity} ·{' '}
                            {formatRemaining(prog.remainingMs)}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            disabled={action.busy}
                            onClick={() => void entrarComoControlador(room.slug)}
                          >
                            Controlar
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={action.busy || prog.remainingMs <= 0}
                            onClick={() => void estender(room.slug)}
                          >
                            +30 min
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={action.busy}
                            onClick={() => void encerrar(room.slug)}
                          >
                            Encerrar
                          </Button>
                        </div>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-primary transition-[width]"
                          style={{ width: `${prog.pct}%` }}
                        />
                      </div>
                      <div className="flex gap-2">
                        <input
                          readOnly
                          value={convite}
                          className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 font-mono text-xs"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void copiar(convite)}
                        >
                          Copiar
                        </Button>
                      </div>
                      {room.designatedDisplayName ? (
                        <p className="text-xs text-muted-foreground">
                          Controlador designado: {room.designatedDisplayName}
                        </p>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {user.role === 'admin' && history.length ? (
          <Card>
            <CardHeader>
              <CardTitle>Histórico (admin)</CardTitle>
              <CardDescription>Salas expiradas ou encerradas.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2 text-sm">
                {history.slice(0, 40).map((room) => (
                  <li key={`${room.slug}-${room.createdAt}`} className="text-muted-foreground">
                    <span className="font-medium text-foreground">{room.slug}</span> · {room.status}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </Pagina>
  )
}
