import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from './app'

vi.mock('./routes/host-page', () => ({
  HostPage: () => <div>Pagina host</div>,
}))
vi.mock('./routes/home-page', () => ({
  HomePage: () => <div>Pagina inicio</div>,
}))
vi.mock('./routes/salas-page', () => ({
  SalasPage: () => <div>Pagina salas</div>,
}))
vi.mock('./routes/sala-page', () => ({
  SalaPage: () => <div>Pagina assistir</div>,
}))
vi.mock('./routes/preferencias-page', () => ({
  PreferenciasPage: () => <div>Pagina preferencias</div>,
}))
vi.mock('@/shell/profile', () => ({
  ProfileProvider: ({ children }: { children: ReactNode }) => children,
  useProfile: () => ({
    ready: true,
    deviceId: 'abc',
    displayName: 'Cris',
    room: null,
    error: '',
    refresh: async () => undefined,
    saveName: async () => null,
  }),
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('rotas', () => {
  it(' /salas/:room renderiza o host', () => {
    renderAt('/salas/casa')
    expect(screen.getByText('Pagina host')).toBeInTheDocument()
  })

  it('/host/:room redireciona para /salas/:room', () => {
    renderAt('/host/casa')
    expect(screen.getAllByText('Pagina host').length).toBeGreaterThan(0)
    expect(screen.queryByText('Pagina salas')).not.toBeInTheDocument()
  })

  it('/salas lista a página de salas', () => {
    renderAt('/salas')
    expect(screen.getByText('Pagina salas')).toBeInTheDocument()
  })
})
