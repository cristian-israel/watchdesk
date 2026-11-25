import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ActionDialogProvider } from '@/actions/action-dialog'
import { apiOrThrow } from '@/lib/api'
import { SalasPage } from './salas-page'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  apiOrThrow: vi.fn(),
}))

const refresh = vi.fn(async () => undefined)

vi.mock('@/shell/profile', () => ({
  useProfile: () => ({
    rooms: [],
    displayName: 'Cris',
    refresh,
  }),
}))

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  }
})

const mockedApiOrThrow = vi.mocked(apiOrThrow)

describe('SalasPage', () => {
  it('cria transmissão com joinMode ask por padrão', async () => {
    mockedApiOrThrow.mockResolvedValue({ room: 'abc123' })
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <ActionDialogProvider>
          <SalasPage />
        </ActionDialogProvider>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: 'Começar a transmitir' }))

    expect(mockedApiOrThrow).toHaveBeenCalledWith('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ joinMode: 'ask', maxViewers: 8, voiceEnabled: false }),
    })
  })
})
