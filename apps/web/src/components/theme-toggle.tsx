import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { type ThemeMode, useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

const OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'system', label: 'Sistema', icon: Monitor },
  { mode: 'light', label: 'Claro', icon: Sun },
  { mode: 'dark', label: 'Escuro', icon: Moon },
]

export function ThemeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useTheme()

  return (
    <div
      role="group"
      aria-label="Modo de aparência"
      className={cn(
        'inline-flex rounded-lg border border-border bg-background/80 p-0.5 shadow-sm backdrop-blur-sm',
        className,
      )}
    >
      {OPTIONS.map(({ mode: value, label, icon: Icon }) => (
        <Button
          key={value}
          type="button"
          size="icon"
          variant={mode === value ? 'secondary' : 'ghost'}
          aria-label={label}
          aria-pressed={mode === value}
          title={label}
          onClick={() => setMode(value)}
        >
          <Icon />
        </Button>
      ))}
    </div>
  )
}
