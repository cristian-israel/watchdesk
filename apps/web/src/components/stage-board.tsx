import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type StageItem = {
  slot: number
  label: string
  stream: MediaStream
  /** Preview local — sem áudio no elemento */
  muted?: boolean
  onStop?: () => void
}

function StageVideo({
  item,
  large,
  className,
}: {
  item: StageItem
  large?: boolean
  className?: string
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.srcObject = item.stream
    el.muted = Boolean(item.muted)
    void el.play().catch(() => {
      /* autoplay */
    })
  }, [item.stream, item.muted])

  useEffect(() => {
    function resume() {
      const el = videoRef.current
      if (!el || !el.srcObject) return
      const stream = el.srcObject
      el.srcObject = null
      el.srcObject = stream
      void el.play().catch(() => {
        /* ok */
      })
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') resume()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', resume)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', resume)
    }
  }, [])

  return (
    <div className={cn('relative overflow-hidden rounded-xl bg-black', className)}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={item.muted}
        className={cn(
          'block bg-black object-contain',
          large ? 'h-full w-full' : 'aspect-video w-full',
        )}
      />
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-linear-to-t from-black/70 to-transparent',
          large ? 'px-3 py-2.5' : 'px-1.5 py-1',
        )}
      >
        <span className={cn('truncate text-white', large ? 'text-xs' : 'text-[10px]')}>
          {item.label}
        </span>
        {item.onStop && large ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="pointer-events-auto h-7 shrink-0 rounded-full bg-white/15 text-white hover:bg-white/25"
            onClick={(e) => {
              e.stopPropagation()
              item.onStop?.()
            }}
          >
            Parar
          </Button>
        ) : null}
      </div>
      {large ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="absolute top-2 right-2 h-7 gap-1 rounded-full bg-black/55 px-2.5 text-xs text-white hover:bg-black/70"
          onClick={() => {
            const el = videoRef.current
            if (el) void el.requestFullscreen?.()
          }}
        >
          <Maximize2 className="size-3" />
          Tela cheia
        </Button>
      ) : null}
    </div>
  )
}

type Props = {
  items: StageItem[]
  empty?: ReactNode
  className?: string
}

export function StageBoard({ items, empty, className }: Props) {
  const [focusSlot, setFocusSlot] = useState<number | null>(null)

  useEffect(() => {
    if (!items.length) {
      setFocusSlot(null)
      return
    }
    if (focusSlot == null || !items.some((i) => i.slot === focusSlot)) {
      setFocusSlot(items[0]!.slot)
    }
  }, [items, focusSlot])

  if (!items.length) {
    return <div className={cn('flex h-full min-h-0 items-center justify-center', className)}>{empty}</div>
  }

  const focused = items.find((i) => i.slot === focusSlot) ?? items[0]!
  const showStrip = items.length > 1

  return (
    <div className={cn('flex h-full min-h-0 flex-col md:flex-row', className)}>
      <div className="relative min-h-0 min-w-0 flex-1 p-2 sm:p-3">
        <StageVideo
          item={focused}
          large
          className="h-full w-full rounded-2xl ring-1 ring-white/10"
        />
      </div>

      {showStrip ? (
        <>
          {/* Desktop: coluna à direita */}
          <aside className="hidden w-44 shrink-0 flex-col gap-2 overflow-y-auto border-l border-white/10 p-2 md:flex lg:w-52">
            {items.map((item) => {
              const selected = item.slot === focused.slot
              return (
                <button
                  key={item.slot}
                  type="button"
                  title={item.label}
                  onClick={() => setFocusSlot(item.slot)}
                  className={cn(
                    'overflow-hidden rounded-xl text-left transition',
                    selected ? 'ring-2 ring-primary' : 'ring-1 ring-white/15 hover:ring-white/35',
                  )}
                >
                  <StageVideo item={item} className="rounded-xl" />
                </button>
              )
            })}
          </aside>

          {/* Mobile: faixa embaixo */}
          <div className="flex shrink-0 gap-2 overflow-x-auto border-t border-white/10 p-2 md:hidden">
            {items.map((item) => {
              const selected = item.slot === focused.slot
              return (
                <button
                  key={item.slot}
                  type="button"
                  title={item.label}
                  onClick={() => setFocusSlot(item.slot)}
                  className={cn(
                    'w-36 shrink-0 overflow-hidden rounded-xl',
                    selected ? 'ring-2 ring-primary' : 'ring-1 ring-white/15',
                  )}
                >
                  <StageVideo item={item} className="rounded-xl" />
                </button>
              )
            })}
          </div>
        </>
      ) : null}
    </div>
  )
}
