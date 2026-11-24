# Controle remoto

Assistência remota na LAN: espectador entra **só vendo**; o host promove a **interagir**. Captura com input no SO exige companion nativo no PC que transmite.

## Decisões de produto

- **Companion = console do host** (criar/sincronizar sala, convite, transmitir, promover, preferências). A web do agente é opcional (painel leve).
- Entrar na sala como viewer = `controlMode: view` (+ chat). Sem mouse/teclado no desktop.
- Host promove um espectador para `interact` (e rebaixa/corta a qualquer momento) — no companion ou no painel web.
- **Um piloto por vez.**
- Link de convite **não** concede interagir.
- **Arquitetura híbrida:** web (espectadores + painel opcional) + companion no PC remoto.
- **Um caminho de transmissão por sessão:** web `getDisplayMedia` **ou** companion — nunca os dois.
  - Sem companion: só visualizar (browser share).
  - Com companion: app captura e injeta; browser do host vira **painel** (não é kickado).
- Companion: **Windows e Linux (X11 / xdotool)**. Viewer permanece no browser.
- Update do companion: banner + botão Atualizar; `COMPANION_MANDATORY` bloqueia abaixo de `minVersion`.
- Deep link: `watchdesk://connect?origin=…&room=…&transmit=1`.

## Fluxo agente (recomendado)

```text
Companion: origem + nome → sync → criar sala → copiar convite
Companion: conectar e transmitir
Viewer (browser): abre convite → só vê
Companion: promover viewer → interact
Companion injeta input (xdotool / Win)
```

## Fluxo técnico

```text
viewer join → controlMode=view
host/panel set_control(peer, interact) → só esse peer envia input no DataChannel
companion injeta no SO se peer == piloto
set_control(peer, view) → revoga
```

Quando o companion assume a mídia, o browser host autenticado passa a `role=panel` (sem fechar o WS).

## Fases

| Fase | Entrega |
| --- | --- |
| 0 | Documento |
| 1 | `controlMode`, UI promover, Recentes |
| 2 | Companion Windows + DataChannel + update |
| 3 | Audit, limites UAC, versionamento |
| A–D | Companion console completo, persistência, deep link, web como painel leve |

## API / WS

- `controlMode: 'view' | 'interact'`
- Host ou **panel** → `set_control`
- Só o host de mídia → `slot_add` / ofertas WebRTC
- Input: **DataChannel** `watchdesk-input`

## Companion

- Código: `apps/companion`
- Persistência: `userData/companion-settings.json`
- Instalador: `deploy/companion/`

## Fora de escopo

- Multi-piloto
- Transmitir web + companion juntos
- Wayland puro (input)
