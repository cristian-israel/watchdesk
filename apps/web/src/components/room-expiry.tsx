import { useEffect, useState } from 'react'
import { formatRemaining } from '@/lib/api'
import { cn } from '@/lib/utils'

export function RoomExpiryCountdown({
  expiresAt,
  className,
}: {
  expiresAt: string | null | undefined
  className?: string
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!expiresAt) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [expiresAt])

  if (!expiresAt) return null

  const end = new Date(expiresAt).getTime()
  const remainingMs = Math.max(0, end - now)
  const urgent = remainingMs > 0 && remainingMs <= 60_000
  const gone = remainingMs <= 0

  return (
    <span
      className={cn(
        'font-mono text-xs tabular-nums',
        gone ? 'text-destructive' : urgent ? 'text-amber-500' : 'text-muted-foreground',
        className,
      )}
      title="Tempo até a sala expirar"
    >
      {gone ? 'Expirada' : formatRemaining(remainingMs)}
    </span>
  )
}
