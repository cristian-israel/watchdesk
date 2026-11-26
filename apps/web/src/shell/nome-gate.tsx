import { FormEvent, useState } from 'react'
import { Loader } from 'lucide-react'
import { useActionDialog } from '@/actions/action-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Mode = 'choose' | 'login' | 'guest'

export function NomeGate({
  saveName,
  login,
}: {
  saveName: (name: string) => Promise<string | null>
  login: (login: string, password: string) => Promise<string | null>
}) {
  const action = useActionDialog()
  const [mode, setMode] = useState<Mode>('choose')
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
    <main className="grid min-h-svh place-items-center bg-background p-6">
      <div className="grid w-full max-w-md gap-6">
        <p className="font-heading text-2xl font-semibold tracking-tight">Watchdesk</p>

        {mode === 'choose' ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Entrar</CardTitle>
              <CardDescription>
                Conta autenticada cria salas. Convidado só assiste pelo link.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Button type="button" className="w-full" onClick={() => setMode('login')}>
                Login
              </Button>
              <Button type="button" variant="outline" className="w-full" onClick={() => setMode('guest')}>
                Sou convidado
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {mode === 'login' ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Entrar</CardTitle>
              <CardDescription>Contas são criadas pelo admin.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4" onSubmit={(e) => void onLogin(e)} autoComplete="on">
                <div className="grid gap-2">
                  <Label htmlFor="login">Login</Label>
                  <Input
                    id="login"
                    name="login"
                    autoComplete="username"
                    value={loginName}
                    onChange={(e) => setLoginName(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="senha">Senha</Label>
                  <Input
                    id="senha"
                    name="senha"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Button type="button" variant="ghost" onClick={() => setMode('choose')}>
                    Voltar
                  </Button>
                  <Button type="submit" className="w-fit px-4" disabled={action.busy}>
                    {action.busy ? (
                      <>
                        <Loader className="animate-spin" />
                        Entrando
                      </>
                    ) : (
                      'Entrar'
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : null}

        {mode === 'guest' ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Convidado</CardTitle>
              <CardDescription>
                Apelido com 2 a 32 caracteres. Sem criar salas.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4" onSubmit={(e) => void onGuest(e)} autoComplete="off">
                <div className="grid gap-2">
                  <Label htmlFor="apelido">Apelido</Label>
                  <Input
                    id="apelido"
                    name="apelido"
                    value={apelido}
                    onChange={(e) => setApelido(e.target.value)}
                    minLength={2}
                    maxLength={32}
                    required
                    autoFocus
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Button type="button" variant="ghost" onClick={() => setMode('choose')}>
                    Voltar
                  </Button>
                  <Button type="submit" className="w-fit px-4" disabled={action.busy}>
                    {action.busy ? (
                      <>
                        <Loader className="animate-spin" />
                        Entrando
                      </>
                    ) : (
                      'Continuar'
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </main>
  )
}
