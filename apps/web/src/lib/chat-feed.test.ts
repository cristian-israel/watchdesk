import { describe, expect, it } from 'vitest'
import { appendMessage, appendSystem, joinedLine, leftLine, messagesToFeed } from './chat-feed'
import type { ChatMessage } from './signal'

const msg = (id: number, body = 'oi'): ChatMessage => ({
  id,
  authorName: 'Cris',
  role: 'viewer',
  body,
  createdAt: '2026-01-01T00:00:00.000Z',
})

describe('chat-feed', () => {
  it('converte histórico sem duplicar ids', () => {
    const feed = messagesToFeed([msg(1), msg(2)])
    expect(feed.map((item) => item.id)).toEqual(['m-1', 'm-2'])
  })

  it('ignora mensagem já presente', () => {
    const first = appendMessage([], msg(1))
    const again = appendMessage(first, msg(1))
    expect(again).toHaveLength(1)
  })

  it('linhas de sistema em português', () => {
    expect(joinedLine('Ana', 'host')).toBe('Ana entrou como host')
    expect(joinedLine('Ana', 'viewer')).toBe('Ana entrou')
    expect(leftLine('Ana', 'host')).toBe('Ana (host) saiu')
    expect(leftLine('Ana', 'viewer')).toBe('Ana saiu')
  })

  it('appendSystem usa a chave no id', () => {
    const feed = appendSystem([], 'entrou', 'join-1')
    expect(feed[0]?.type).toBe('system')
    expect(feed[0]?.id.startsWith('s-join-1-')).toBe(true)
  })
})
