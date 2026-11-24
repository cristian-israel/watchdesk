export const ROOM_RE = /^[a-zA-Z0-9_-]{1,40}$/

export function viewerInviteUrl(slug: string, origin = location.origin) {
  return `${origin}/sala/${encodeURIComponent(slug)}`
}

/** Aceita link completo, path /sala/id ou só o id opaco. */
export function parseInviteInput(input: string, origin = location.origin) {
  const text = input.trim()
  if (!text) return null

  try {
    const url = new URL(text, origin)
    const match = url.pathname.match(/\/sala\/([a-zA-Z0-9_-]{1,40})\/?$/)
    if (match) return { slug: match[1] }
  } catch {
    /* bare id below */
  }

  if (ROOM_RE.test(text)) return { slug: text }
  return null
}
