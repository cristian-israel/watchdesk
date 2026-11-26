import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function ControlButton({
  label,
  active,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-40',
        danger
          ? 'bg-destructive text-white hover:bg-destructive/90'
          : active
            ? 'bg-primary text-primary-foreground hover:bg-primary/90'
            : 'bg-muted text-foreground hover:bg-muted/80',
      )}
    >
      {children}
    </button>
  )
}

/** Separador visual entre grupos da ilha (mic+tela | painéis | sair). */
export function IslandDivider() {
  return <span className="mx-0.5 h-6 w-px shrink-0 bg-border" aria-hidden />
}
