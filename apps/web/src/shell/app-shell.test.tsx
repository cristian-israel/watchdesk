import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionDialogProvider } from '@/actions/action-dialog'
import { AppShell } from './app-shell'
import { useProfile } from './profile'
import { ShellModeProvider, useShellMode } from './shell-mode'

vi.mock('./profile', () => ({
  useProfile: vi.fn(),
  consumePreferLogin: () => false,
}))

const mockedProfile = vi.mocked(useProfile)

const baseProfile = {
  ready: true,
  deviceId: 'abc',
  displayName: '',
  user: null,
  rooms: [],
  slots: { used: 0, max: 0 },
  error: '',
  refresh: async () => undefined,
  saveName: async () => null,
  login: async () => null,
  logout: async () => undefined,
  exitGuest: async () => null,
  enterLogin: async () => null,
}

function renderShell(children = <div>conteudo</div>) {
  return render(
    <MemoryRouter>
      <ActionDialogProvider>
        <ShellModeProvider>
          <AppShell>{children}</AppShell>
        </ShellModeProvider>
      </ActionDialogProvider>
    </MemoryRouter>,
  )
}

describe('AppShell', () => {
  afterEach(() => {
    cleanup()
  })

  it('sem apelido mostra gate login/convidado, sem nav', () => {
    mockedProfile.mockReturnValue({ ...baseProfile })
    renderShell()
    expect(screen.getByText('Watchdesk')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sou convidado' })).toBeInTheDocument()
    expect(screen.queryByText('conteudo')).not.toBeInTheDocument()
    expect(screen.queryByText('Início')).not.toBeInTheDocument()
    expect(screen.queryByText('Salas')).not.toBeInTheDocument()
  })

  it('com apelido mostra o app e a nav', () => {
    mockedProfile.mockReturnValue({
      ...baseProfile,
      displayName: 'Cris',
      user: {
        id: 1,
        login: 'cris',
        displayName: 'Cris',
        role: 'user',
        active: true,
      },
      slots: { used: 0, max: 2 },
    })
    renderShell()
    expect(screen.getByText('conteudo')).toBeInTheDocument()
    expect(screen.getAllByText('Início').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Salas').length).toBeGreaterThan(0)
  })

  it('modo imersivo não remonta a rota', async () => {
    mockedProfile.mockReturnValue({
      ...baseProfile,
      displayName: 'Cris',
    })

    let mounts = 0
    function Probe() {
      const { immersive, setImmersive } = useShellMode()
      useEffect(() => {
        mounts += 1
      }, [])
      return (
        <div>
          <span data-testid="probe">ok</span>
          <span data-testid="mode">{immersive ? 'on' : 'off'}</span>
          <button type="button" onClick={() => setImmersive(true)}>
            entrar imersivo
          </button>
        </div>
      )
    }

    renderShell(<Probe />)
    expect(mounts).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'entrar imersivo' }))
    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('on'))
    expect(mounts).toBe(1)
    expect(screen.getByTestId('probe')).toBeInTheDocument()
  })
})
