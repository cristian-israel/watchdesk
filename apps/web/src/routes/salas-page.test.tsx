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

    await user.type(screen.getByLabelText('Nome da sala'), 'casa')
    await user.type(screen.getByLabelText('Chave do host'), 'abcdefgh')
    await user.type(screen.getByLabelText('Chave dos espectadores'), 'ijklmnop')
    await user.click(screen.getByRole('button', { name: 'Criar sala' }))

    expect(mockedApiOrThrow).toHaveBeenCalledWith('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        slug: 'casa',
        hostKey: 'abcdefgh',
        viewerKey: 'ijklmnop',
        maxViewers: 8,
      }),
    })
  })
})
