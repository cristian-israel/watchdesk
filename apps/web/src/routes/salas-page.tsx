import { useState } from 'react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router'
import { useActionDialog } from '@/actions/action-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { apiOrThrow, type SessionInfo } from '@/lib/api'
import { viewerInviteUrl } from '@/lib/room'
import { Pagina } from '@/shell/pagina'
import { useProfile } from '@/shell/profile'

export function SalasPage() {
  const navigate = useNavigate()
  const action = useActionDialog()
  const { rooms, refresh, displayName } = useProfile()
  const [joinMode, setJoinMode] = useState<'ask' | 'open'>('ask')
  const [voiceEnabled, setVoiceEnabled] = useState(false)

  async function novaTransmissao() {
    await action.run({ pending: 'Criando…', success: 'Sala pronta' }, async () => {
      const created = await apiOrThrow<SessionInfo>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ joinMode, maxViewers: 8, voiceEnabled }),
      })
      await refresh()
      navigate(`/salas/${encodeURIComponent(created.room)}`)
    })
  }

  async function reabrir(slug: string) {
    await action.run({ pending: 'Entrando…', success: 'Pronto' }, async () => {
      await apiOrThrow<SessionInfo>(`/api/rooms/${encodeURIComponent(slug)}/resume`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      navigate(`/salas/${encodeURIComponent(slug)}`)
    })
  }

  async function excluir(slug: string) {
    if (!window.confirm(`Excluir a sala ${slug}? Quem estiver nela sai na hora.`)) return
    await action.run({ pending: 'Excluindo…', success: 'Sala excluída' }, async () => {
      await apiOrThrow(`/api/rooms/${encodeURIComponent(slug)}`, { method: 'DELETE' })
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

  return (
    <Pagina
      titulo="Salas"
      descricao="Crie uma transmissão, copie o link e compartilhe a tela. Sem senha — só o link."
    >
      <div className="flex flex-col gap-4">
        {rooms.length ? (
          <Card>
            <CardHeader>
              <CardTitle>Sua sala</CardTitle>
              <CardDescription>
                Um aparelho, uma sala. Reabra para transmitir ou exclua para criar outra.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-3">
                {rooms.slice(0, 1).map((room) => {
                  const convite = viewerInviteUrl(room.slug)
                  return (
                    <li
                      key={room.slug}
                      className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-medium">{room.slug}</p>
                          <p className="text-sm text-muted-foreground">
                            {room.active ? 'ativa' : 'desativada'} ·{' '}
                            {room.joinMode === 'open' ? 'pública' : 'com aceite'}
                            {room.voiceEnabled ? ' · voz' : ''} · máx. {room.maxViewers}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            disabled={action.busy}
                            onClick={() => void reabrir(room.slug)}
                          >
                            Transmitir
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={action.busy}
                            onClick={() => void excluir(room.slug)}
                          >
                            Excluir
                          </Button>
                        </div>
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
                    </li>
                  )
                })}
              </ul>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Nova transmissão</CardTitle>
              <CardDescription>
                {displayName
                  ? `Como ${displayName}. Escolha se quem chega precisa do seu aceite.`
                  : 'Defina seu nome no menu antes de transmitir.'}
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
                Ativar voz na sala
              </label>
              <Button
                type="button"
                disabled={action.busy || !displayName}
                onClick={() => void novaTransmissao()}
              >
                Começar a transmitir
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </Pagina>
  )
}
