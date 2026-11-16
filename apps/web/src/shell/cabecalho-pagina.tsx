import type { ReactNode } from 'react'

export function CabecalhoPagina({
  titulo,
  descricao,
  total,
  acoes,
}: {
  titulo: string
  descricao: string
  total?: number
  acoes?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="grid gap-1">
        <div className="flex items-center gap-2.5">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">{titulo}</h1>
          {total !== undefined ? (
            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-muted px-2 text-xs font-medium tabular-nums text-muted-foreground">
              {total}
            </span>
          ) : null}
        </div>
        <p className="max-w-2xl text-muted-foreground">{descricao}</p>
      </div>
      {acoes ? <div className="flex flex-wrap justify-end gap-2">{acoes}</div> : null}
    </div>
  )
}
