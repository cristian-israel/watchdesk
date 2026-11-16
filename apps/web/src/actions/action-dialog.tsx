import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'

export type ActionState =
  | { status: 'idle' }
  | { status: 'pending'; pending: string }
  | { status: 'success'; success: string }
  | { status: 'error'; message: string }

type ActionDialogValue = {
  state: ActionState
  busy: boolean
  run: (
    labels: { pending: string; success: string },
    task: () => Promise<void>,
    options?: { silenciarErro?: (error: unknown) => boolean },
  ) => Promise<void>
  fail: (message: string) => void
}

const ActionDialogContext = createContext<ActionDialogValue | null>(null)
const idle: ActionState = { status: 'idle' }

export function ActionDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ActionState>(idle)
  const busyRef = useRef(false)

  const close = useCallback(() => {
    busyRef.current = false
    setState(idle)
  }, [])

  const fail = useCallback((message: string) => {
    if (busyRef.current) {
      return
    }

    busyRef.current = true
    setState({ status: 'error', message })
  }, [])

  const run = useCallback(
    async (
      labels: { pending: string; success: string },
      task: () => Promise<void>,
      options?: { silenciarErro?: (error: unknown) => boolean },
    ) => {
      if (busyRef.current) {
        return
      }

      busyRef.current = true
      setState({ status: 'pending', pending: labels.pending })

      try {
        await task()
        setState({ status: 'success', success: labels.success })
      } catch (error) {
        if (options?.silenciarErro?.(error)) {
          busyRef.current = false
          setState(idle)
          return
        }

        const message = error instanceof Error && error.message ? error.message : 'Não foi possível concluir'
        setState({ status: 'error', message })
      }
    },
    [],
  )

  const value = {
    state,
    busy: state.status !== 'idle',
    run,
    fail,
  }

  return (
    <ActionDialogContext.Provider value={value}>
      {children}
      <ActionDialog state={state} onClose={close} />
    </ActionDialogContext.Provider>
  )
}

export function useActionDialog() {
  const value = useContext(ActionDialogContext)
  if (!value) {
    throw new Error('useActionDialog precisa do ActionDialogProvider.')
  }

  return value
}

function ActionDialog({ state, onClose }: { state: ActionState; onClose: () => void }) {
  const shownRef = useRef(state)
  if (state.status !== 'idle') {
    shownRef.current = state
  }

  const shown = state.status === 'idle' ? shownRef.current : state

  useEffect(() => {
    if (state.status !== 'success' && state.status !== 'error') {
      return
    }

    const delay = state.status === 'success' ? 1000 : 4000
    const timer = window.setTimeout(onClose, delay)
    return () => window.clearTimeout(timer)
  }, [state, onClose])

  return (
    <Dialog
      open={state.status !== 'idle'}
      onOpenChange={(open) => {
        if (!open && state.status === 'error') {
          onClose()
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay className="z-80 bg-background/60" />
        <DialogPrimitive.Content
          aria-labelledby="action-dialog-title"
          aria-describedby={shown.status === 'error' ? 'action-dialog-message' : undefined}
          className="fixed top-1/2 left-1/2 z-80 grid w-full max-w-sm -translate-x-1/2 -translate-y-1/2 justify-items-center gap-4 rounded-xl bg-card p-6 text-center text-sm text-card-foreground ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          onInteractOutside={(event) => {
            if (state.status !== 'error') {
              event.preventDefault()
            }
          }}
          onEscapeKeyDown={(event) => {
            if (state.status !== 'error') {
              event.preventDefault()
            }
          }}
        >
          {shown.status === 'pending' ? <Loader /> : null}
          {shown.status === 'success' ? <SuccessMark /> : null}
          {shown.status === 'error' ? <ErrorMark /> : null}
          <DialogTitle id="action-dialog-title" className="text-lg font-semibold">
            {shown.status === 'pending' ? shown.pending : null}
            {shown.status === 'success' ? shown.success : null}
            {shown.status === 'error' ? 'Não foi possível concluir' : null}
          </DialogTitle>
          {shown.status === 'error' ? (
            <DialogDescription id="action-dialog-message">{shown.message}</DialogDescription>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

function Loader() {
  return (
    <svg className="size-10 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function SuccessMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-12 text-primary" aria-hidden="true">
      <circle
        cx="24"
        cy="24"
        r="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        style={{ strokeDasharray: 126, strokeDashoffset: 126, animation: 'action-draw 0.45s ease forwards' }}
      />
      <path
        d="M14 25 l7 7 l13-15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ strokeDasharray: 36, strokeDashoffset: 36, animation: 'action-draw 0.35s ease 0.2s forwards' }}
      />
    </svg>
  )
}

function ErrorMark() {
  return (
    <svg
      viewBox="0 0 48 48"
      className="size-12 text-destructive"
      aria-hidden="true"
      style={{ animation: 'action-shake 0.35s ease' }}
    >
      <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M17 17 l14 14 M31 17 l-14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
