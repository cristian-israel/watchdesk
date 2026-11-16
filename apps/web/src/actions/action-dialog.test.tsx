import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ActionDialogProvider, useActionDialog } from './action-dialog'

function Probe({ task }: { task: () => Promise<void> }) {
  const action = useActionDialog()
  return (
    <button type="button" onClick={() => void action.run({ pending: 'Salvando…', success: 'Pronto' }, task)}>
      ir
    </button>
  )
}

describe('ActionDialog', () => {
  it('mostra pending e depois success', async () => {
    vi.useFakeTimers()
    let resolveTask: (() => void) | undefined
    const task = () =>
      new Promise<void>((resolve) => {
        resolveTask = resolve
      })

    render(
      <ActionDialogProvider>
        <Probe task={task} />
      </ActionDialogProvider>,
    )

    await act(async () => {
      screen.getByRole('button', { name: 'ir' }).click()
    })
    expect(screen.getByText('Salvando…')).toBeInTheDocument()

    await act(async () => {
      resolveTask?.()
    })
    expect(screen.getByText('Pronto')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    expect(screen.queryByText('Pronto')).not.toBeInTheDocument()
    vi.useRealTimers()
  })
})
