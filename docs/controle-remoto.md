# Controle remoto (ideia futura)

Status: **não implementado**. Registro para quando fizer sentido evoluir o produto.

## Situação hoje

O host transmite com `getDisplayMedia` no browser (WebRTC P2P). O espectador só **vê** (e usa chat). A página web **não** pode injetar mouse/teclado no desktop do sistema — restrição do browser.

## Objetivo

Permitir que um espectador autorizado **interaja** no PC de quem está transmitindo (cliques, teclado), no estilo assistência remota leve — sem virar AnyDesk completo de primeira.

## Por que não basta o web atual

| Camada | Browser hoje |
| --- | --- |
| Vídeo da tela | Sim (`getDisplayMedia`) |
| Eventos do viewer → host | Dá via DataChannel |
| Aplicar input no SO do host | **Não** — precisa processo nativo / Electron / Tauri |

## Direção preferida

Manter o Watchdesk web para sala, sinalização, vídeo e chat. No PC do **host**, um companion opcional (“permitir controle remoto”):

```text
viewer (mouse/teclado normalizados na tela)
  → WebRTC DataChannel (mesmo P2P da sala)
  → companion no host
  → injeta input no SO (Linux/Windows)
```

### Regras de produto (rascunho)

- Host precisa **ativar** o controle; default off.
- Um piloto por vez (ou fila / host escolhe quem controla).
- Mesma autenticação da sala (sessão / convite); não abrir input só porque alguém tem o link de “assistir”.
- Indicador claro no host: “fulano está controlando”.
- Host pode cortar a qualquer momento (e companion pode exigir confirmação periódica).

### Fora de escopo inicial

- Controle só via página web sem agente.
- Multi-piloto simultâneo.
- Transferência de arquivos / clipboard completo (pode vir depois).
- Expor o companion na internet sem o mesmo modelo LAN/alias do app.

## Alternativas descartadas por agora

- **Só canvas web:** controla um app embutido, não o desktop da empresa.
- **RDP/VNC atrás do Watchdesk:** outro produto; não reaproveita o fluxo de sala atual.

## Encaixe técnico com o que já existe

- Sinalização e ICE/TURN continuam iguais.
- Novo canal: DataChannel (ou mensagens tipadas no WS só para “pedir/aceitar controle”; o stream de eventos deve ir no DataChannel para latência).
- Companion fala com a mesma sala (token de host / device).
- Deploy do companion: binário ou instalador no PC do host — **não** no container do servidor.

## Pendências antes de implementar

- [ ] Confirmar SO alvo (só Linux da LAN Giga? Windows também?)
- [ ] UX: quem pede controle, quem aprova, timeout
- [ ] Modelo de permissão na API (role `pilot` vs `viewer`)
- [ ] Stack do companion (Tauri vs Electron vs agente mínimo)
- [ ] Testes de latência na LAN e política se P2P cair no TURN
