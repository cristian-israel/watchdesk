import { useEffect, useRef } from 'react'
import { SignalClient, type SignalInbound } from '@/lib/signal'

const RETRY_MS = 1500

export function useSignal(
  enabled: boolean,
  onMessage: (msg: SignalInbound) => void,
  onDisconnect?: () => void,
) {
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  const onDisconnectRef = useRef(onDisconnect)
  onDisconnectRef.current = onDisconnect
  const clientRef = useRef<SignalClient | null>(null)
  const welcomedRef = useRef(false)

  useEffect(() => {
    if (!enabled) {
      welcomedRef.current = false
      clientRef.current?.close()
      clientRef.current = null
      return
    }

    let cancelled = false
    let timer: number | undefined

    function connect() {
      if (cancelled) return
      clientRef.current?.close()
      const client = new SignalClient()
      clientRef.current = client
      client.onMessage = (msg) => {
        if (msg.type === 'welcome') welcomedRef.current = true
        onMessageRef.current(msg)
      }
      client.onClose = () => {
        if (cancelled || !welcomedRef.current) return
        onDisconnectRef.current?.()
        timer = window.setTimeout(connect, RETRY_MS)
      }
      welcomedRef.current = false
      client.connect()
    }

    connect()

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
      clientRef.current?.close()
      clientRef.current = null
    }
  }, [enabled])

  return {
    send: (msg: Parameters<SignalClient['send']>[0]) => clientRef.current?.send(msg),
    client: clientRef,
  }
}
