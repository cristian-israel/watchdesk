import { FormEvent, useEffect, useState } from 'react'
import { Check, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useProfile } from './profile'

export function NomeAparelho() {
  const { displayName, saveName } = useProfile()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(displayName)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!editing) setValue(displayName)
  }, [displayName, editing])

  if (!displayName) return null

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const message = await saveName(value)
    setBusy(false)
    if (message) {
      setError(message)
      return
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <form className="flex flex-col gap-1" onSubmit={(e) => void onSubmit(e)}>
        <div className="flex items-center gap-1">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={80}
            aria-label="Seu nome"
            autoFocus
            required
          />
          <Button type="submit" size="icon" variant="ghost" aria-label="Salvar nome" disabled={busy}>
            <Check />
          </Button>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </form>
    )
  }

  return (
    <div className="flex items-center gap-1 px-1">
      <span className="min-w-0 flex-1 truncate text-sm">{displayName}</span>
      <Button type="button" size="icon" variant="ghost" aria-label="Renomear" onClick={() => setEditing(true)}>
        <Pencil />
      </Button>
    </div>
  )
}
