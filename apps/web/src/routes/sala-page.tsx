import { FormEvent, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ICE, basicAuth, sleep } from '@/lib/auth'

type StreamInfo = { name: string; whep: string }

type TileEntry = {
  name: string
  stopped: boolean
  stop?: () => void
}

export function SalaPage() {
  const { room = '' } = useParams()
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(false)
  const [streams, setStreams] = useState<StreamInfo[]>([])
  const authRef = useRef('')
  const activeRef = useRef(false)
  const tilesRef = useRef(new Map<string, TileEntry>())
  const peersRef = useRef(new Set<RTCPeerConnection>())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const m = location.hash.match(/[#&]k=([^&]*)/)
    const fromLink = m ? decodeURIComponent(m[1]) : ''
    if (fromLink) history.replaceState(null, '', location.pathname)
    let stored = ''
    try {
      stored = sessionStorage.getItem(`k:${room}`) || ''
    } catch {
      /* ok */
    }
    const initial = fromLink || stored
    if (initial) {
      setKey(initial)
      void enter(initial)
    }
    return () => leave(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  async function fetchStreams(auth: string) {
    const r = await fetch(`/api/streams?room=${encodeURIComponent(room)}`, {
      headers: { Authorization: auth },
    })
    if (r.status === 401) throw new Error('Chave incorreta.')
    if (r.status === 429) throw new Error('Muitas tentativas. Aguarde 1 minuto.')
    if (!r.ok) throw new Error(`Não foi possível entrar (${r.status}).`)
    return (await r.json()) as { streams: StreamInfo[] }
  }

  async function enter(viewerKey: string) {
    setError('')
    setBusy(true)
    try {
      const auth = basicAuth('viewer', viewerKey)
      const { streams: list } = await fetchStreams(auth)
      try {
        sessionStorage.setItem(`k:${room}`, viewerKey)
      } catch {
        /* ok */
      }
      authRef.current = auth
      activeRef.current = true
      setActive(true)
      setStreams(list)
      syncTiles(list, auth)
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(() => void poll(auth), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao entrar.')
    } finally {
      setBusy(false)
    }
  }

  async function poll(auth: string) {
    try {
      const { streams: list } = await fetchStreams(auth)
      setStreams(list)
      syncTiles(list, auth)
    } catch (e) {
      if (e instanceof Error && e.message === 'Chave incorreta.') leave()
    }
  }

  function syncTiles(list: StreamInfo[], auth: string) {
    const grid = gridRef.current
    if (!grid) return
    const wanted = new Set(list.map((s) => s.whep))
    for (const [url, t] of tilesRef.current) {
      if (wanted.has(url)) continue
      t.stopped = true
      t.stop?.()
      grid.querySelector(`[data-whep="${CSS.escape(url)}"]`)?.remove()
      tilesRef.current.delete(url)
    }
    for (const s of list) {
      if (tilesRef.current.has(s.whep)) continue
      const tile = document.createElement('div')
      tile.dataset.whep = s.whep
      tile.className =
        'tile relative overflow-hidden rounded-xl border border-border bg-black ring-1 ring-foreground/10'
      tile.innerHTML =
        '<video autoplay muted playsinline class="block aspect-video w-full bg-black object-contain"></video>' +
        '<span class="tag absolute left-2.5 top-2.5 rounded-full bg-black/65 px-2 py-0.5 text-xs text-white"></span>' +
        '<span class="state absolute inset-0 grid place-items-center text-sm text-muted-foreground pointer-events-none">Conectando…</span>' +
        '<button type="button" class="fs absolute right-2.5 top-2.5 rounded bg-black/65 px-2 py-0.5 text-xs text-white">Tela cheia</button>'
      const tag = tile.querySelector('.tag') as HTMLElement
      tag.textContent = s.name
      const video = tile.querySelector('video') as HTMLVideoElement
      tile.querySelector('.fs')!.addEventListener('click', () => {
        void video.requestFullscreen?.()
      })
      video.addEventListener('playing', () => tile.classList.add('live'))
      grid.appendChild(tile)
      const entry: TileEntry = { name: s.name, stopped: false }
      tilesRef.current.set(s.whep, entry)
      void keepPlaying(s, entry, video, tile, auth)
    }
  }

  async function keepPlaying(
    stream: StreamInfo,
    entry: TileEntry,
    video: HTMLVideoElement,
    tile: HTMLElement,
    auth: string,
  ) {
    const state = tile.querySelector('.state') as HTMLElement
    while (activeRef.current && !entry.stopped) {
      try {
        await whepOnce(stream.whep, video, auth, entry)
      } catch (e) {
        state.textContent =
          e instanceof Error && e.message === 'sem-stream'
            ? 'Aguardando o host transmitir…'
            : 'Reconectando…'
      }
      tile.classList.remove('live')
      if (!entry.stopped) await sleep(2000)
    }
  }

  async function whepOnce(
    url: string,
    video: HTMLVideoElement,
    auth: string,
    entry: TileEntry,
  ) {
    const pc = new RTCPeerConnection({ iceServers: ICE })
    peersRef.current.add(pc)
    try {
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.ontrack = (e) => {
        video.srcObject = e.streams[0]
      }
      await pc.setLocalDescription(await pc.createOffer())
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve()
        const t = setTimeout(() => resolve(), 1500)
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(t)
            resolve()
          }
        }
      })
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Authorization: auth },
        body: pc.localDescription!.sdp,
      })
      if (r.status === 401) {
        activeRef.current = false
        throw new Error('auth')
      }
      if (r.status === 404) throw new Error('sem-stream')
      if (r.status !== 201) throw new Error(`http-${r.status}`)
      await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() })
      await new Promise<void>((resolve) => {
        entry.stop = resolve
        pc.onconnectionstatechange = () => {
          if (['failed', 'closed'].includes(pc.connectionState)) resolve()
        }
      })
    } finally {
      peersRef.current.delete(pc)
      pc.close()
    }
  }

  function leave(clearKey = true) {
    activeRef.current = false
    setActive(false)
    if (clearKey) {
      try {
        sessionStorage.removeItem(`k:${room}`)
      } catch {
        /* ok */
      }
      setKey('')
    }
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
    tilesRef.current.forEach((t) => {
      t.stopped = true
      t.stop?.()
    })
    tilesRef.current.clear()
    gridRef.current?.replaceChildren()
    peersRef.current.forEach((pc) => pc.close())
    peersRef.current.clear()
    setStreams([])
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void enter(key)
  }

  if (!active) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Sala {room}</CardTitle>
            <CardDescription>Digite a chave dos espectadores para assistir.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-3" onSubmit={onSubmit} autoComplete="off">
              <div className="space-y-2">
                <Label htmlFor="key">Chave</Label>
                <Input
                  id="key"
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <Button type="submit" disabled={busy} className="w-full">
                Entrar
              </Button>
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-card/80 px-4 py-3 backdrop-blur">
        <b className="font-medium">Sala {room}</b>
        <Button type="button" variant="outline" size="sm" onClick={() => leave()}>
          Sair
        </Button>
      </header>
      <div
        ref={gridRef}
        className="grid flex-1 content-start gap-3 p-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]"
      />
      {!streams.length ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">Aguardando o host transmitir…</p>
      ) : null}
      <style>{`.tile.live .state{display:none}`}</style>
    </div>
  )
}
