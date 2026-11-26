import { FormEvent, useEffect, useState } from 'react'
import { Check, LogIn, LogOut, Pencil } from 'lucide-react'
import { useActionDialog } from '@/actions/action-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useProfile } from './profile'

export function NomeAparelho() {
  const action = useActionDialog()
  const { displayName, user, saveName, logout, exitGuest, enterLogin } = useProfile()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(displayName)

  useEffect(() => {
    if (!editing) setValue(displayName)
  }, [displayName, editing])

  if (!displayName) return null

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const name = value.trim()
    if (name.length < 2 || name.length > 32) {
      action.fail('Apelido: 2 a 32 caracteres.')
      return
    }
    await action.run({ pending: 'Salvando…', success: 'Apelido atualizado' }, async () => {
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
            minLength={2}
            maxLength={32}
            aria-label="Seu apelido"
            autoFocus
            required
          />
          <Button type="submit" size="icon" variant="ghost" aria-label="Salvar apelido" disabled={action.busy}>
            <Check />
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-1 px-1">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-sm">
          {displayName}
          {user ? (
            <span className="text-muted-foreground"> · @{user.login}</span>
          ) : (
            <span className="text-muted-foreground"> · convidado</span>
          )}
        </span>
        <Button type="button" size="icon" variant="ghost" aria-label="Renomear" onClick={() => setEditing(true)}>
          <Pencil />
        </Button>
        {user ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Sair"
            onClick={() => void logout()}
          >
            <LogOut />
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Entrar"
              disabled={action.busy}
              onClick={() =>
                void action.run({ pending: 'Abrindo login…', success: 'Pronto' }, async () => {
                  const message = await enterLogin()
                  if (message) throw new Error(message)
                })
              }
            >
              <LogIn />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Sair"
              disabled={action.busy}
              onClick={() =>
                void action.run({ pending: 'Saindo…', success: 'Até logo' }, async () => {
                  const message = await exitGuest()
                  if (message) throw new Error(message)
                })
              }
            >
              <LogOut />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
