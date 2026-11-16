import type { ChatMessage } from '@/lib/signal'

export type ChatFeedItem =
  | { id: string; type: 'message'; message: ChatMessage }
  | { id: string; type: 'system'; text: string }

export function messagesToFeed(messages: ChatMessage[]): ChatFeedItem[] {
  return messages.map((m) => ({ id: `m-${m.id}`, type: 'message' as const, message: m }))
}

export function appendMessage(prev: ChatFeedItem[], message: ChatMessage): ChatFeedItem[] {
  const id = `m-${message.id}`
  if (prev.some((item) => item.id === id)) return prev
  return [...prev, { id, type: 'message', message }]
}

export function appendSystem(prev: ChatFeedItem[], text: string, key: string): ChatFeedItem[] {
  return [...prev, { id: `s-${key}-${Date.now()}`, type: 'system', text }]
}

export function joinedLine(displayName: string, role: 'host' | 'viewer') {
  return role === 'host' ? `${displayName} entrou como host` : `${displayName} entrou`
}

export function leftLine(displayName: string, role: 'host' | 'viewer') {
  return role === 'host' ? `${displayName} (host) saiu` : `${displayName} saiu`
}
