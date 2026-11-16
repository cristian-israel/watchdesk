import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ActionDialogProvider } from '@/actions/action-dialog'
import { AppShell } from './app-shell'
import { useProfile } from './profile'
import { ShellModeProvider } from './shell-mode'

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
})
