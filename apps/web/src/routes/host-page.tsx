import { FormEvent, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ICE, basicAuth } from '@/lib/auth'

const MAX_SLOTS = 8

type ShareEntry = {
  pc: RTCPeerConnection
  stream: MediaStream
  session: string | null
  state: 'connecting' | 'live'
}

export function HostPage() {
  const { room = '' } = useParams()
  const [hostKey, setHostKey] = useState('')
  const [viewerKey, setViewerKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState(false)
  const [links, setLinks] = useState<string[]>([])
  const [shares, setShares] = useState<Map<number, ShareEntry>>(new Map())
  const hostKeyRef = useRef('')
  const sharesRef = useRef(shares)
  sharesRef.current = shares

  useEffect(() => {
    return () => {
      ;[...sharesRef.current.keys()].forEach((slot) => stop(slot))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function auth() {
    return basicAuth('publisher', hostKeyRef.current)
  }

  async function onEnter(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    hostKeyRef.current = hostKey
    try {
      const put = await fetch(`/api/rooms/${encodeURIComponent(room)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostKey, viewerKey }),
      })
      if (put.status === 401) throw new Error('Chave do host incorreta (sala já existe com outra chave).')
      if (put.status === 429) throw new Error('Muitas tentativas. Aguarde 1 minuto.')
      if (!put.ok) throw new Error((await put.text()) || `Falha ao registrar sala (${put.status}).`)
      const data = (await put.json()) as { links: string[] }

      const check = await fetch(`/api/host-check?room=${encodeURIComponent(room)}`, {
        headers: { Authorization: auth() },
      })
      if (!check.ok) throw new Error('Não foi possível validar o host.')

      const local = ['localhost', '127.0.0.1'].includes(location.hostname)
      const self = `${location.origin}/sala/${room}`
      const withKey = viewerKey
        ? `${self}#k=${encodeURIComponent(viewerKey)}`
        : self
      const all = [
        ...(local ? [withKey] : [withKey, ...data.links.map((l) => (viewerKey ? `${l}#k=${encodeURIComponent(viewerKey)}` : l))]),
      ]
      setLinks([...new Set(all)])
      setPanel(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao entrar.')
    } finally {
      setBusy(false)
    }
  }

  async function shareScreen() {
    setError('')
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError('Este endereço não permite compartilhar tela. Use localhost ou HTTPS.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      })
      await publish(stream)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return
      setError(err instanceof Error ? err.message : 'Falha ao compartilhar.')
    }
  }

  async function publish(stream: MediaStream) {
    const [track] = stream.getVideoTracks()
    if ('contentHint' in track) track.contentHint = 'detail'

    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      if (sharesRef.current.has(slot)) continue
      const res = await tryPublish(slot, stream)
      if (res === 'busy') continue
      return
    }
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('Limite de telas atingido.')
  }

  async function tryPublish(slot: number, stream: MediaStream): Promise<'ok' | 'busy'> {
    const pc = new RTCPeerConnection({ iceServers: ICE })
    const entry: ShareEntry = { pc, stream, session: null, state: 'connecting' }
    setShares((prev) => new Map(prev).set(slot, entry))
    try {
      const sender = pc.addTransceiver(stream.getVideoTracks()[0], {
        direction: 'sendonly',
        streams: [stream],
      }).sender
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
      const r = await fetch(`/whip/${room}/monitor${slot}/whip`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp',
          Authorization: auth(),
        },
        body: pc.localDescription!.sdp,
      })
      if (r.status === 401) throw new Error('Chave do host incorreta.')
      if (r.status === 429) throw new Error('Muitas tentativas. Aguarde 1 minuto.')
      if (r.status !== 201) {
        pc.close()
        setShares((prev) => {
          const next = new Map(prev)
          next.delete(slot)
          return next
        })
        return 'busy'
      }
      entry.session = r.headers.get('Location')
      await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() })
      try {
        const p = sender.getParameters()
        if (p.encodings?.[0]) {
          p.encodings[0].maxBitrate = 4_000_000
          await sender.setParameters(p)
        }
      } catch {
        /* opcional */
      }
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          entry.state = 'live'
          setShares((prev) => new Map(prev).set(slot, { ...entry }))
        }
        if (['failed', 'closed'].includes(pc.connectionState)) stop(slot)
      }
      if (pc.connectionState === 'connected') entry.state = 'live'
      stream.getVideoTracks()[0].addEventListener('ended', () => stop(slot))
      setShares((prev) => new Map(prev).set(slot, { ...entry }))
      return 'ok'
    } catch (err) {
      stop(slot)
      throw err
    }
  }

  function stop(slot: number) {
    const e = sharesRef.current.get(slot)
    if (!e) return
    setShares((prev) => {
      const next = new Map(prev)
      next.delete(slot)
      return next
    })
    if (e.session) {
      void fetch(e.session, {
        method: 'DELETE',
        headers: { Authorization: auth() },
        keepalive: true,
      }).catch(() => {})
    }
    try {
      e.pc.close()
    } catch {
      /* ok */
    }
    e.stream.getTracks().forEach((t) => t.stop())
  }

  async function copy(url: string, btn: HTMLButtonElement) {
    try {
      await navigator.clipboard.writeText(url)
      btn.textContent = 'Copiado'
    } catch {
      btn.textContent = 'Selecione'
    }
    setTimeout(() => {
      btn.textContent = 'Copiar'
    }, 1500)
  }

  if (!panel) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Transmitir — {room}</CardTitle>
            <CardDescription>
              Defina a chave do host e a chave que os espectadores usarão nesta sala.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-3" onSubmit={onEnter} autoComplete="off">
              <div className="space-y-2">
                <Label htmlFor="hostKey">Chave do host</Label>
                <Input
                  id="hostKey"
                  type="password"
                  value={hostKey}
                  onChange={(e) => setHostKey(e.target.value)}
                  minLength={4}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="viewerKey">Chave dos espectadores</Label>
                <Input
                  id="viewerKey"
                  type="password"
                  value={viewerKey}
                  onChange={(e) => setViewerKey(e.target.value)}
                  minLength={4}
                  required
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

  const sorted = [...shares.entries()].sort((a, b) => a[0] - b[0])

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Transmitir — {room}</CardTitle>
          <CardDescription>
            Compartilhe monitores, janelas ou abas. Fechar esta aba encerra a transmissão.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button
            type="button"
            className="w-full"
            disabled={shares.size >= MAX_SLOTS}
            onClick={() => void shareScreen()}
          >
            Compartilhar uma tela
          </Button>
          <p className="text-sm text-muted-foreground">
            Para mais de um monitor, clique de novo e escolha outro.
          </p>

          <div>
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              No ar
            </h2>
            {!sorted.length ? (
              <p className="text-sm text-muted-foreground">Nada sendo compartilhado.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {sorted.map(([slot, e]) => (
                  <li
                    key={slot}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2"
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <span
                        className={`size-2 rounded-full ${e.state === 'live' ? 'bg-primary' : 'bg-muted-foreground'}`}
                      />
                      Tela {slot + 1}
                      {e.state === 'live' ? ' · transmitindo' : ' · conectando…'}
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={() => stop(slot)}>
                      Parar
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Link para espectadores
            </h2>
            <ul className="flex flex-col gap-2">
              {links.map((url) => (
                <li
                  key={url}
                  className="flex items-start justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2"
                >
                  <span className="font-mono text-xs break-all">{url}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={(ev) => void copy(url, ev.currentTarget)}
                  >
                    Copiar
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-muted-foreground">
              Quem abrir o link precisa da chave dos espectadores que você definiu.
            </p>
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
