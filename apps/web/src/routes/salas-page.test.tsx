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

vi.mock('@/shell/profile', () => ({
  useProfile: () => ({
    room: null,
    displayName: 'Cris',
    refresh: vi.fn(async () => undefined),
  }),
}))

const mockedApiOrThrow = vi.mocked(apiOrThrow)

describe('SalasPage', () => {
  it('envia POST /api/rooms ao criar', async () => {
    mockedApiOrThrow.mockResolvedValue({})
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <ActionDialogProvider>
          <SalasPage />
        </ActionDialogProvider>
      </MemoryRouter>,
    )

    await user.clear(screen.getByLabelText('Máx. espectadores (1–8)'))
    await user.type(screen.getByLabelText('Máx. espectadores (1–8)'), '4')
    await user.click(screen.getByRole('button', { name: 'Criar sala' }))

    expect(mockedApiOrThrow).toHaveBeenCalledWith('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ maxViewers: 4 }),
    })
  })
})
