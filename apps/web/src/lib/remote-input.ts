import type { RemoteInputEvent } from '@/lib/signal'

/** Anexa listeners de mouse/teclado no elemento de vídeo quando controlMode=interact. */
export function bindRemoteInput(
  el: HTMLElement,
  send: (ev: RemoteInputEvent) => void,
): () => void {
  function norm(e: PointerEvent) {
    const r = el.getBoundingClientRect()
    const x = r.width ? (e.clientX - r.left) / r.width : 0
    const y = r.height ? (e.clientY - r.top) / r.height : 0
    return {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    }
  }

  const onMove = (e: PointerEvent) => {
    const { x, y } = norm(e)
    send({ type: 'move', x, y })
  }
  const onDown = (e: PointerEvent) => {
    el.setPointerCapture(e.pointerId)
    const { x, y } = norm(e)
    send({ type: 'down', x, y, button: e.button })
  }
  const onUp = (e: PointerEvent) => {
    const { x, y } = norm(e)
    send({ type: 'up', x, y, button: e.button })
  }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const r = el.getBoundingClientRect()
    const x = r.width ? (e.clientX - r.left) / r.width : 0
    const y = r.height ? (e.clientY - r.top) / r.height : 0
    send({ type: 'wheel', x, y, dx: e.deltaX, dy: e.deltaY })
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return
    send({ type: 'keydown', key: e.key, code: e.code })
  }
  const onKeyUp = (e: KeyboardEvent) => {
    send({ type: 'keyup', key: e.key, code: e.code })
  }

  el.tabIndex = 0
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('wheel', onWheel, { passive: false })
  el.addEventListener('keydown', onKeyDown)
  el.addEventListener('keyup', onKeyUp)

  return () => {
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('keydown', onKeyDown)
    el.removeEventListener('keyup', onKeyUp)
  }
}
