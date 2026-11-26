import { FormEvent, useState } from 'react'
import { useActionDialog } from '@/actions/action-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { consumePreferLogin } from './profile'

type Mode = 'choose' | 'login' | 'guest'

export function NomeGate({
  saveName,
  login,
}: {
  saveName: (name: string) => Promise<string | null>
  login: (login: string, password: string) => Promise<string | null>
}) {
  const action = useActionDialog()
  const [mode, setMode] = useState<Mode>(() => (consumePreferLogin() ? 'login' : 'choose'))
  const [apelido, setApelido] = useState('')
  const [loginName, setLoginName] = useState('')
  const [password, setPassword] = useState('')

  async function onGuest(e: FormEvent) {
    e.preventDefault()
    const name = apelido.trim()
    if (name.length < 2 || name.length > 32) {
      action.fail('Apelido: 2 a 32 caracteres.')
      return
    }
    await action.run({ pending: 'Entrando…', success: 'Pronto' }, async () => {
      const message = await saveName(name)
      if (message) throw new Error(message)
    })
  }

  async function onLogin(e: FormEvent) {
    e.preventDefault()
    await action.run({ pending: 'Entrando…', success: 'Bem-vindo' }, async () => {
      const message = await login(loginName.trim(), password)
      if (message) throw new Error(message)
    })
  }

  return (
    <div className="flex h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        {mode === 'choose' ? (
          <>
            <CardHeader>
              <CardTitle>Watchdesk</CardTitle>
              <CardDescription>
                Entre com sua conta para criar salas, ou como convidado para assistir.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button type="button" onClick={() => setMode('login')} className="w-full">
                Login
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setMode('guest')}
                className="w-full"
              >
                Sou convidado
              </Button>
            </CardContent>
          </>
        ) : null}

        {mode === 'login' ? (
          <>
            <CardHeader>
              <CardTitle>Login</CardTitle>
              <CardDescription>Contas são criadas pelo admin.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-3" onSubmit={(e) => void onLogin(e)} autoComplete="on">
                <div className="space-y-2">
                  <Label htmlFor="login">Login</Label>
                  <Input
                    id="login"
                    value={loginName}
                    onChange={(e) => setLoginName(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="senha">Senha da conta</Label>
                  <Input
                    id="senha"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" disabled={action.busy} className="w-full">
                  Entrar
                </Button>
                <Button type="button" variant="ghost" onClick={() => setMode('choose')}>
                  Voltar
                </Button>
              </form>
            </CardContent>
          </>
        ) : null}

        {mode === 'guest' ? (
          <>
            <CardHeader>
              <CardTitle>Convidado</CardTitle>
              <CardDescription>
                Apelido com 2 a 32 caracteres. Convidados não criam salas.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-3" onSubmit={(e) => void onGuest(e)} autoComplete="off">
                <div className="space-y-2">
                  <Label htmlFor="apelido">Apelido</Label>
                  <Input
                    id="apelido"
                    value={apelido}
                    onChange={(e) => setApelido(e.target.value)}
                    minLength={2}
                    maxLength={32}
                    required
                    autoFocus
                  />
                </div>
                <Button type="submit" disabled={action.busy} className="w-full">
                  Continuar
                </Button>
                <Button type="button" variant="ghost" onClick={() => setMode('choose')}>
                  Voltar
                </Button>
              </form>
            </CardContent>
          </>
        ) : null}
      </Card>
    </div>
  )
}
