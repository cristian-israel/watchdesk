import { FormEvent, useEffect, useState } from 'react'
import { Check, Pencil } from 'lucide-react'
import { useActionDialog } from '@/actions/action-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useProfile } from './profile'

export function NomeAparelho() {
  const action = useActionDialog()
  const { displayName, saveName } = useProfile()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(displayName)

  useEffect(() => {
    if (!editing) setValue(displayName)
  }, [displayName, editing])

  if (!displayName) return null

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const name = value.trim()
    if (!name) {
      action.fail('Informe seu nome.')
      return
    }
    await action.run({ pending: 'Salvando…', success: 'Nome atualizado' }, async () => {
      const message = await saveName(name)
      if (message) throw new Error(message)
      setEditing(false)
    })
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
          <Button type="submit" size="icon" variant="ghost" aria-label="Salvar nome" disabled={action.busy}>
            <Check />
          </Button>
        </div>
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
