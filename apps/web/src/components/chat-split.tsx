import { type ReactNode, useEffect, useRef, useState } from 'react'
import { MessageSquare, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { usePanelRef } from 'react-resizable-panels'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { cn } from '@/lib/utils'
import { useShellMode } from '@/shell/shell-mode'

const STORAGE_KEY = 'watchdesk.chatPanel'
const DEFAULT_SIZE = 28

type Stored = {
  size: number
  minimized: boolean
}

function readStored(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Stored> | null
    if (raw && typeof raw.size === 'number' && Number.isFinite(raw.size)) {
      return {
        size: Math.min(55, Math.max(18, raw.size)),
        minimized: Boolean(raw.minimized),
      }
    }
  } catch {
    /* ignore */
  }
  return { size: DEFAULT_SIZE, minimized: false }
}

function writeStored(next: Stored) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}

function useIsDesktop() {
  const [desktop, setDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 640px)').matches : true,
  )

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    const onChange = () => setDesktop(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return desktop
}

type Props = {
  children: ReactNode
  chat: ReactNode
}

export function ChatSplit({ children, chat }: Props) {
  const { immersive } = useShellMode()
  const desktop = useIsDesktop()
  const initial = useRef(readStored())
  const [minimized, setMinimized] = useState(initial.current.minimized)
  const sizeRef = useRef(initial.current.size)
  const chatPanelRef = usePanelRef()
  const persistTimer = useRef<number | undefined>(undefined)

  function persist(partial: Partial<Stored>) {
    const next: Stored = {
      size: partial.size ?? sizeRef.current,
      minimized: partial.minimized ?? minimized,
    }
    sizeRef.current = next.size
    writeStored(next)
    if (partial.minimized !== undefined) setMinimized(partial.minimized)
  }

  useEffect(() => {
    if (!desktop) return
    const id = requestAnimationFrame(() => {
      const panel = chatPanelRef.current
      if (!panel) return
      if (minimized && !panel.isCollapsed()) panel.collapse()
      if (!minimized && panel.isCollapsed()) panel.expand()
    })
    return () => cancelAnimationFrame(id)
  }, [desktop, minimized, chatPanelRef])

  function minimize() {
    persist({ minimized: true })
    chatPanelRef.current?.collapse()
  }

  function restore() {
    persist({ minimized: false })
    chatPanelRef.current?.expand()
  }

  if (!desktop) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', !immersive && 'pb-20 sm:pb-0')}>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        {minimized ? (
          <button
            type="button"
            className="flex shrink-0 items-center justify-center gap-2 border-t border-border bg-card/80 px-3 py-2.5 text-sm font-medium"
            onClick={() => persist({ minimized: false })}
          >
            <MessageSquare className="size-4" />
            Mensagens
          </button>
        ) : (
          <div className="flex h-[40vh] shrink-0 flex-col border-t border-border bg-card/40">
            <ChatChrome onMinimize={() => persist({ minimized: true })} />
            <div className="min-h-0 flex-1">{chat}</div>
          </div>
        )}
      </div>
    )
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
      <ResizablePanel
        id="main"
        defaultSize={`${100 - initial.current.size}`}
        minSize="30%"
        className="min-h-0"
      >
        <div className="h-full min-h-0 overflow-hidden">{children}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel
        id="chat"
        panelRef={chatPanelRef}
        collapsible
        collapsedSize="0%"
        collapsedThreshold="8%"
        minSize="18%"
        maxSize="55%"
        defaultSize={`${initial.current.size}`}
        className="min-h-0"
        onResize={(panelSize) => {
          const collapsed = chatPanelRef.current?.isCollapsed() ?? false
          if (!collapsed) {
            sizeRef.current = Math.min(55, Math.max(18, panelSize.asPercentage))
          }
          if (persistTimer.current) window.clearTimeout(persistTimer.current)
          persistTimer.current = window.setTimeout(() => {
            writeStored({ size: sizeRef.current, minimized: collapsed })
            setMinimized(collapsed)
          }, 120)
        }}
      >
        {minimized ? (
          <div className="flex h-full flex-col items-center border-l border-border bg-card/40 py-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Abrir mensagens"
              onClick={restore}
            >
              <PanelRightOpen className="size-4" />
            </Button>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col border-l border-border bg-card/40">
            <ChatChrome onMinimize={minimize} />
            <div className="min-h-0 flex-1">{chat}</div>
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function ChatChrome({ onMinimize }: { onMinimize: () => void }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Mensagens
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Minimizar mensagens"
        onClick={onMinimize}
      >
        <PanelRightClose className="size-4" />
      </Button>
    </div>
  )
}
