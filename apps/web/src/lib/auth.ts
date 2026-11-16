export function basicAuth(user: string, key: string) {
  const bytes = new TextEncoder().encode(`${user}:${key}`)
  let binary = ''
  bytes.forEach((b) => {
    binary += String.fromCharCode(b)
  })
  return `Basic ${btoa(binary)}`
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
