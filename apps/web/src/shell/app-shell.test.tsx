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
}))

const mockedProfile = vi.mocked(useProfile)

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

  it('sem nome mostra só o gate, sem nav', () => {
    mockedProfile.mockReturnValue({
      ready: true,
      deviceId: 'abc',
      displayName: '',
      room: null,
      error: '',
      refresh: async () => undefined,
      saveName: async () => null,
    })
    renderShell()
    expect(screen.getByText('Como podemos te chamar?')).toBeInTheDocument()
    expect(screen.queryByText('conteudo')).not.toBeInTheDocument()
    expect(screen.queryByText('Início')).not.toBeInTheDocument()
    expect(screen.queryByText('Salas')).not.toBeInTheDocument()
  })

  it('com nome mostra o app e a nav', () => {
    mockedProfile.mockReturnValue({
      ready: true,
      deviceId: 'abc',
      displayName: 'Cris',
      room: null,
      error: '',
      refresh: async () => undefined,
      saveName: async () => null,
    })
    renderShell()
    expect(screen.getByText('conteudo')).toBeInTheDocument()
    expect(screen.getAllByText('Início').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Salas').length).toBeGreaterThan(0)
  })

  it('modo imersivo não remonta a rota', async () => {
    mockedProfile.mockReturnValue({
      ready: true,
      deviceId: 'abc',
      displayName: 'Cris',
      room: null,
      error: '',
      refresh: async () => undefined,
      saveName: async () => null,
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
