# Controle remoto

Assistência remota na LAN: espectador entra **só vendo**; o host promove a **interagir**. Captura com input no SO exige companion nativo no PC que transmite.

## Decisões de produto

- Entrar na sala = `controlMode: view` (+ chat). Sem mouse/teclado no desktop.
- Host promove um espectador para `interact` (e rebaixa/corta a qualquer momento).
- **Um piloto por vez.** No MVP o host promove sozinho (pedido do viewer fica para depois).
- Link de convite **não** concede interagir.
- **Arquitetura híbrida:** web (salas, viewer, painel do host) + companion `.exe` no PC remoto.
- **Um caminho de transmissão por sessão:** web `getDisplayMedia` **ou** companion — nunca os dois publicando vídeo juntos.
  - Sem companion: só visualizar (como hoje).
  - Com companion na sala: o exe captura e injeta; o browser no mesmo PC é painel (lista, promover, chat).
- Companion: **Windows e Linux (X11 / xdotool)**. Viewer permanece no browser.
- Update do companion: banner + botão Atualizar (usuário confirma; sem force silencioso no MVP).

## Fluxo

```text
viewer join → controlMode=view
host set_control(peer, interact) → só esse peer envia input no DataChannel
companion injeta no SO se peer == piloto
host set_control(peer, view) → revoga
```

## Fases

| Fase | Entrega |
| --- | --- |
| 0 | Este documento |
| 1 | `controlMode` na API/WS, UI promover/rebaixar, badge no viewer, lista **Recentes** (últimos assistidos) |
| 2 | Companion Windows: captura, DataChannel, SendInput, check/update de versão |
| 3 | Multi-monitor/DPI, audit, update obrigatório opcional, limites UAC — ver [controle-remoto-limites.md](controle-remoto-limites.md) |
| 4+ | Linux companion, clipboard/arquivo, viewer pede controle, inventário tipo AnyDesk |

Companion: código em `apps/companion` (Electron Windows). Instalador em `deploy/companion/`.

## API / WS (Fase 1+)

- Por viewer em runtime: `controlMode: 'view' | 'interact'` (default `view` no join).
- Host → API: `set_control { peerId, mode }`
- Broadcast: `control_changed { peerId, mode, displayName }`
- Input de ponteiro/teclado: **DataChannel** (não WS), coords normalizadas 0–1.
- Audit (Fase 3): registro de quem promoveu/revogou.

## Recentes (viewer)

- Home: lista das últimas salas em que o `device_id` entrou como viewer.
- Persistência no servidor; limite curto (ex. 10).
- Clique reabre a sala; se a chave regenerou, pedir o link de novo.

## Companion (Fase 2+)

- Binário no PC do host (não no container do servidor).
- Mesma sala/sessão host; versão reportada ao conectar.
- `GET`/`latest.json` na LAN com versão + URL do instalador.
- Só injeta input se `controlMode === interact` para aquele peer.

## Fora de escopo do MVP

- Controle só com página web no host (sem companion).
- Multi-piloto simultâneo.
- Transmitir web + exe ao mesmo tempo.
- Expor companion fora do modelo alias/LAN.
- Paridade TeamViewer no dia 1.

## Limites conhecidos (documentar na Fase 3)

- UAC / tela de login Windows podem bloquear input.
- DPI e multi-monitor exigem mapeamento explícito.
- TURN aumenta latência do DataChannel vs P2P puro.
