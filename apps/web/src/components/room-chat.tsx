import { FormEvent, useEffect, useRef, useState } from 'react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from '@/components/ui/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import type { ChatFeedItem } from '@/lib/chat-feed'
import type { ChatMessage } from '@/lib/signal'
import { cn } from '@/lib/utils'

type Props = {
  items: ChatFeedItem[]
  onSend: (body: string) => void
  selfName: string
  selfDeviceId?: string
  disabled?: boolean
}

type MessageRun = {
  type: 'group'
  key: string
  authorName: string
  role: ChatMessage['role']
  mine: boolean
  messages: ChatMessage[]
}

type SystemRun = {
  type: 'system'
  key: string
  text: string
}

type FeedRun = MessageRun | SystemRun

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function isMine(message: ChatMessage, selfName: string, selfDeviceId?: string) {
  if (selfDeviceId && message.authorDeviceId) return message.authorDeviceId === selfDeviceId
  return message.authorName === selfName
}

function buildRuns(items: ChatFeedItem[], selfName: string, selfDeviceId?: string): FeedRun[] {
  const runs: FeedRun[] = []
  for (const item of items) {
    if (item.type === 'system') {
      runs.push({ type: 'system', key: item.id, text: item.text })
      continue
    }
    const last = runs[runs.length - 1]
    const m = item.message
    if (
      last?.type === 'group' &&
      last.authorName === m.authorName &&
      last.role === m.role
    ) {
      last.messages.push(m)
      continue
    }
    runs.push({
      type: 'group',
      key: item.id,
      authorName: m.authorName,
      role: m.role,
      mine: isMine(m, selfName, selfDeviceId),
      messages: [m],
    })
  }
  return runs
}

function entranceClass(side: 'start' | 'end' | 'center') {
  return cn(
    'animate-in fade-in duration-300 fill-mode-both ease-out motion-reduce:animate-none',
    side === 'end' && 'slide-in-from-right-4',
    side === 'start' && 'slide-in-from-left-4',
    side === 'center' && 'slide-in-from-bottom-1',
  )
}

export function RoomChat({ items, onSend, selfName, selfDeviceId, disabled }: Props) {
  const [text, setText] = useState('')
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set())
  const seenRef = useRef<Set<string>>(new Set())
  const self = selfName.trim()
  const runs = buildRuns(items, self, selfDeviceId)

  useEffect(() => {
    if (!items.length) {
      seenRef.current = new Set()
      setFreshIds(new Set())
      return
    }

    const previouslySeen = seenRef.current
    const added: string[] = []
    for (const item of items) {
      if (!previouslySeen.has(item.id)) added.push(item.id)
    }
    seenRef.current = new Set(items.map((item) => item.id))

    // Histórico / troca completa: não anima o lote inteiro.
    const historyBatch = added.length === items.length && items.length > 1
    const initialHistory = !previouslySeen.size && items.length > 1
    if (historyBatch || initialHistory) {
      setFreshIds(new Set())
      return
    }

    if (added.length) setFreshIds(new Set(added))
  }, [items])

  function submit(e: FormEvent) {
    e.preventDefault()
    const body = text.trim()
    if (!body || disabled) return
    onSend(body)
    setText('')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="h-full">
            <MessageScrollerViewport>
              <MessageScrollerContent className="gap-4 px-3 py-3">
                {!items.length ? (
                  <p className="px-1 text-sm text-muted-foreground">Nenhuma mensagem ainda.</p>
                ) : (
                  runs.map((run) => {
                    if (run.type === 'system') {
                      return (
                        <MessageScrollerItem
                          key={run.key}
                          messageId={run.key}
                          className={freshIds.has(run.key) ? entranceClass('center') : undefined}
                        >
                          <p className="py-1 text-center text-xs text-muted-foreground">{run.text}</p>
                        </MessageScrollerItem>
                      )
                    }

                    const align = run.mine ? 'end' : 'start'
                    const lastIndex = run.messages.length - 1

                    return (
                      <MessageGroup key={run.key}>
                        {run.messages.map((m, index) => {
                          const first = index === 0
                          const last = index === lastIndex
                          const feedId = `m-${m.id}`
                          return (
                            <MessageScrollerItem
                              key={m.id}
                              messageId={feedId}
                              scrollAnchor={run.mine && last}
                              className={freshIds.has(feedId) ? entranceClass(align) : undefined}
                            >
                              <Message align={align}>
                                <MessageAvatar>
                                  {last ? (
                                    <Avatar size="sm">
                                      <AvatarFallback>{initials(m.authorName)}</AvatarFallback>
                                    </Avatar>
                                  ) : null}
                                </MessageAvatar>
                                <MessageContent>
                                  {first && !run.mine ? (
                                    <MessageHeader>
                                      {m.authorName}
                                      {m.role === 'host' ? (
                                        <span className="ml-1.5 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                                          Host
                                        </span>
                                      ) : null}
                                    </MessageHeader>
                                  ) : null}
                                  <Bubble align={align} variant={run.mine ? 'default' : 'muted'}>
                                    <BubbleContent>{m.body}</BubbleContent>
                                  </Bubble>
                                  {last ? (
                                    <MessageFooter>{formatTime(m.createdAt)}</MessageFooter>
                                  ) : null}
                                </MessageContent>
                              </Message>
                            </MessageScrollerItem>
                          )
                        })}
                      </MessageGroup>
                    )
                  })
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>

      <form className="flex gap-2 border-t border-border p-2" onSubmit={submit}>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Mensagem…"
          maxLength={500}
          disabled={disabled}
        />
        <Button type="submit" disabled={disabled || !text.trim()}>
          Enviar
        </Button>
      </form>
    </div>
  )
}
