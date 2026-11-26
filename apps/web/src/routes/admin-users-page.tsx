import { FormEvent, useEffect, useState } from 'react'
import { useActionDialog } from '@/actions/action-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiOrThrow, type AuthUser } from '@/lib/api'
import { Pagina } from '@/shell/pagina'
import { useProfile } from '@/shell/profile'

export function AdminUsersPage() {
  const action = useActionDialog()
  const { user } = useProfile()
  const [users, setUsers] = useState<AuthUser[]>([])
  const [login, setLogin] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'user' | 'admin'>('user')

  async function load() {
    const data = await apiOrThrow<{ users: AuthUser[] }>('/api/admin/users')
    setUsers(data.users || [])
  }

  useEffect(() => {
    if (user?.role === 'admin') void load()
  }, [user])

  if (user?.role !== 'admin') {
    return (
      <Pagina titulo="Usuários" descricao="Área restrita ao admin.">
        <p className="text-sm text-muted-foreground">Sem permissão.</p>
      </Pagina>
    )
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    await action.run({ pending: 'Criando…', success: 'Usuário criado' }, async () => {
      await apiOrThrow('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ login, displayName, password, role }),
      })
      setLogin('')
      setDisplayName('')
      setPassword('')
      setRole('user')
      await load()
    })
  }

  async function deactivate(id: number) {
    if (!window.confirm('Desativar este usuário?')) return
    await action.run({ pending: 'Desativando…', success: 'Desativado' }, async () => {
      await apiOrThrow(`/api/admin/users/${id}`, { method: 'DELETE' })
      await load()
    })
  }

  return (
    <Pagina titulo="Usuários" descricao="Só o admin cria contas. Sem self-signup.">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Novo usuário</CardTitle>
            <CardDescription>Login, apelido, senha da conta e papel.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-3" onSubmit={(e) => void onCreate(e)}>
              <div className="space-y-2">
                <Label htmlFor="u-login">Login</Label>
                <Input id="u-login" value={login} onChange={(e) => setLogin(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="u-apelido">Apelido (2–32)</Label>
                <Input
                  id="u-apelido"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  minLength={2}
                  maxLength={32}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="u-senha">Senha da conta</Label>
                <Input
                  id="u-senha"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={4}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={role === 'user' ? 'default' : 'outline'}
                  onClick={() => setRole('user')}
                >
                  Normal
                </Button>
                <Button
                  type="button"
                  variant={role === 'admin' ? 'default' : 'outline'}
                  onClick={() => setRole('admin')}
                >
                  Admin
                </Button>
              </div>
              <Button type="submit" disabled={action.busy}>
                Criar
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Lista</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {users.map((u) => (
                <li
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <div>
                    <p className="font-medium">
                      {u.displayName}{' '}
                      <span className="font-normal text-muted-foreground">@{u.login}</span>
                    </p>
                    <p className="text-muted-foreground">
                      {u.role}
                      {u.active ? '' : ' · inativo'}
                    </p>
                  </div>
                  {u.active && u.id !== user.id ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={action.busy}
                      onClick={() => void deactivate(u.id)}
                    >
                      Desativar
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </Pagina>
  )
}
