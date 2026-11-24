export const ROOM_RE = /^[a-zA-Z0-9_-]{1,40}$/
export const KEY_MIN = 8

export function inviteKeyFromHash(hash = typeof location !== 'undefined' ? location.hash : '') {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return ''
  return new URLSearchParams(raw).get('k') || ''
}

export function viewerInviteUrl(slug: string, viewerInvite: string, origin = location.origin) {
  const path = `/sala/${encodeURIComponent(slug)}`
  if (!viewerInvite) return `${origin}${path}`
  return `${origin}${path}#k=${encodeURIComponent(viewerInvite)}`
}

/** Aceita link completo, path /sala/id#k=… ou só o id opaco. */
export function parseInviteInput(input: string, origin = location.origin) {
  const text = input.trim()
  if (!text) return null

  try {
    const url = new URL(text, origin)
    const match = url.pathname.match(/\/sala\/([a-zA-Z0-9_-]{1,40})\/?$/)
    if (match) {
      return { slug: match[1], key: inviteKeyFromHash(url.hash) }
    }
  } catch {
    /* bare id below */
  }

  if (ROOM_RE.test(text)) return { slug: text, key: '' }
  return null
}
