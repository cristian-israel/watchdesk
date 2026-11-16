import { FonteCard } from '@/preferencias/fonte-card'
import { ModoCard } from '@/preferencias/modo-card'
import { TemaCard } from '@/preferencias/tema-card'
import { Pagina } from '@/shell/pagina'

export function PreferenciasPage() {
  return (
    <Pagina titulo="Preferências" descricao="Tema e visual do app.">
      <ModoCard />
      <TemaCard />
      <FonteCard />
    </Pagina>
  )
}
