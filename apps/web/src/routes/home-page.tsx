import { FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { parseInviteInput, viewerInviteUrl } from '@/lib/room'
import { Pagina } from '@/shell/pagina'

type RecentItem = {
  slug: string
  label: string
  lastSeenAt: string
}

export function HomePage() {
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [erro, setErro] = useState('')
  const [recent, setRecent] = useState<RecentItem[]>([])
  const [recentLoading, setRecentLoading] = useState(true)

  useEffect(() => {
    void loadRecent()
  }, [])

  async function loadRecent() {
    setRecentLoading(true)
    const res = await api<{ items: RecentItem[] }>('/api/me/recent')
    if (res.ok) setRecent(res.data.items || [])
    setRecentLoading(false)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const parsed = parseInviteInput(input)
    if (!parsed) {
      setErro('Cole o link de convite ou o id da sala.')
      return
    }
    setErro('')
    const target = viewerInviteUrl(parsed.slug)
    const url = new URL(target)
    navigate(`${url.pathname}${url.hash}`)
  }

  function openRecent(item: RecentItem) {
    const target = viewerInviteUrl(item.slug)
    const url = new URL(target)
    navigate(`${url.pathname}${url.hash}`)
  }

  async function clearRecent() {
    await api('/api/me/recent', { method: 'DELETE' })
    setRecent([])
  }

  return (
    <Pagina titulo="Início" descricao="Assista com o link da sala. Seu nome fica neste aparelho.">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Assistir</CardTitle>
            <CardDescription>Cole o link completo ou só o id da sala — sem senha.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={onSubmit} autoComplete="off">
              <div className="space-y-2">
                <Label htmlFor="invite">Link ou id</Label>
                <Input
                  id="invite"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="https://…/sala/…"
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
