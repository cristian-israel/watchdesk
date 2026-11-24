import { FormEvent, useEffect, useState } from 'react'
import { CircleHelp, Download } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { parseInviteInput, viewerInviteUrl } from '@/lib/room'
import { Pagina } from '@/shell/pagina'

type RecentItem = {
  slug: string
  label: string
  viewerInvite: string
  lastSeenAt: string
}

type CompanionMeta = {
  version: string
  downloadUrl: string
  downloadUrlLinux: string
  notes?: string
}

function detectOs(): 'windows' | 'linux' | 'other' {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('windows')) return 'windows'
  if (ua.includes('linux') || ua.includes('x11')) return 'linux'
  return 'other'
}

export function HomePage() {
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [erro, setErro] = useState('')
  const [recent, setRecent] = useState<RecentItem[]>([])
  const [recentLoading, setRecentLoading] = useState(true)
  const [companion, setCompanion] = useState<CompanionMeta | null>(null)
  const os = detectOs()

  useEffect(() => {
    void loadRecent()
    void loadCompanion()
  }, [])

  async function loadRecent() {
    setRecentLoading(true)
    const res = await api<{ items: RecentItem[] }>('/api/me/recent')
    if (res.ok) setRecent(res.data.items || [])
    setRecentLoading(false)
  }

  async function loadCompanion() {
    const res = await api<CompanionMeta>('/api/companion/version')
    if (res.ok) setCompanion(res.data)
  }

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

  function openRecent(item: RecentItem) {
    const target = viewerInviteUrl(item.slug, item.viewerInvite || '')
    const url = new URL(target)
    navigate(`${url.pathname}${url.hash}`)
  }

  async function clearRecent() {
    await api('/api/me/recent', { method: 'DELETE' })
    setRecent([])
  }

  const winUrl = companion?.downloadUrl || '/companion/watchdesk-companion-setup.exe'
  const linuxUrl = companion?.downloadUrlLinux || '/companion/watchdesk-companion.AppImage'

  return (
    <Pagina titulo="Início" descricao="Assista com o link de convite. Seu nome fica neste aparelho.">
      <div className="flex flex-col gap-4">
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

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
            <div>
              <CardTitle>Companion</CardTitle>
              <CardDescription>
                App no PC do agente para transmitir a tela com controle remoto
                {companion?.version ? ` (v${companion.version})` : ''}.
              </CardDescription>
            </div>
            <Dialog>
              <DialogTrigger asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="Como usar o companion">
                  <CircleHelp />
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md" showCloseButton>
                <DialogHeader>
                  <DialogTitle>Como usar o companion</DialogTitle>
                  <DialogDescription>
                    Use no computador que vai transmitir a tela. Quem só assiste continua no
                    navegador.
                  </DialogDescription>
                </DialogHeader>
                <ol className="list-decimal space-y-2 pl-4 text-sm text-foreground">
                  <li>Baixe o instalador do seu sistema (Windows ou Linux) neste card.</li>
                  <li>
                    Instale ou execute o app no PC do agente.
                    <span className="block text-muted-foreground">
                      Linux (AppImage): dê permissão de execução (
                      <code className="rounded bg-muted px-1 py-0.5 text-xs">chmod +x</code>) e rode
                      o arquivo. Precisa de <code className="rounded bg-muted px-1 py-0.5 text-xs">xdotool</code>{' '}
                      no PATH.
                    </span>
                  </li>
                  <li>Abra o companion e entre na sala (cole o link ou o id).</li>
                  <li>
                    Transmita pelo companion. No mesmo PC, o navegador serve só de painel (promover
                    espectador a interagir, chat).
                  </li>
                  <li>
                    Não use “Compartilhar tela” no browser ao mesmo tempo que o companion.
                  </li>
                  <li>
                    Controle remoto: o host promove o espectador a interagir; no companion dá para
                    revogar.
                  </li>
                </ol>
                {companion?.notes ? (
                  <p className="text-sm text-muted-foreground">{companion.notes}</p>
                ) : null}
                <DialogFooter showCloseButton />
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button asChild variant={os === 'windows' ? 'default' : 'outline'} className="sm:flex-1">
              <a href={winUrl} download>
                <Download />
                Windows (.exe)
              </a>
            </Button>
            <Button asChild variant={os === 'linux' ? 'default' : 'outline'} className="sm:flex-1">
              <a href={linuxUrl} download>
                <Download />
                Linux (AppImage)
              </a>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
            <div>
              <CardTitle>Recentes</CardTitle>
              <CardDescription>Últimas salas que você assistiu neste aparelho.</CardDescription>
            </div>
            {recent.length ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void clearRecent()}>
                Limpar
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            {recentLoading ? (
              <p className="text-sm text-muted-foreground">Carregando…</p>
            ) : !recent.length ? (
              <p className="text-sm text-muted-foreground">Nenhuma sala recente ainda.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {recent.map((item) => (
                  <li key={item.slug}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-sm hover:bg-muted/70"
                      onClick={() => openRecent(item)}
                    >
                      <span className="min-w-0 truncate font-medium">
                        {item.label || item.slug}
                        <span className="font-normal text-muted-foreground"> · {item.slug}</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">Abrir</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </Pagina>
  )
}
