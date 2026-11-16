import type { ReactNode } from 'react'
import { CabecalhoPagina } from './cabecalho-pagina'

export function Pagina({
  titulo,
  descricao,
  total,
  acoes,
  children,
}: {
  titulo: string
  descricao: string
  total?: number
  acoes?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto w-full max-w-5xl shrink-0 px-4 pb-4 md:px-8">
        <CabecalhoPagina titulo={titulo} descricao={descricao} total={total} acoes={acoes} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-20 sm:pb-0">
        <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 pt-1 pb-6 md:px-8 md:pb-8">{children}</div>
      </div>
    </section>
  )
}
