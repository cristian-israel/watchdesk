# Limites do controle remoto (Fase 3)

## Windows / UAC

- Telas de UAC e login (Winlogon) em geral **não** recebem input do companion (sessão isolada).
- Processo precisa rodar na sessão interativa do usuário; serviço em Session 0 não controla o desktop.
- Antivirus pode bloquear `mouse_event` / automação — liberar o companion na política da empresa.

## Linux

- Input via **xdotool** (X11). Wayland puro não é suportado no MVP.
- NixOS: `WATCHDESK_ELECTRON_NO_SANDBOX=1` e `nix-shell -p xdotool` (ou equivalente).
- AppImage: `/companion/watchdesk-companion.AppImage` após `pnpm pack:linux` + `publicar-companion.sh`.

## Multi-monitor e DPI

- Coords do viewer são normalizadas 0–1 na área do vídeo.
- MVP mapeia para o **monitor primário** (tamanho reportado pelo Electron `screen`).
- Multi-monitor completo: escolher display no companion e mapear o retângulo capturado (pendente).
- DPI scaling: testar 125%/150%; se o ponteiro desviar, alinhar com `screen.getPrimaryDisplay().scaleFactor`.

## Rede

- Preferir P2P na LAN; TURN aumenta latência do DataChannel de input.
- Companion desatualizado: banner + update; com `COMPANION_MANDATORY=true` bloqueia transmitir abaixo de `minVersion`.

## Audit

- Tabela `control_audit`: cada `set_control` (promover/rebaixar) grava room, host device, peer, modo, horário.
- Consulta operacional: `SELECT * FROM control_audit WHERE room_id = ? ORDER BY created_at DESC`.

## Update obrigatório

No `.env` da API / ambiente:

```bash
COMPANION_VERSION=0.1.0
COMPANION_MIN_VERSION=0.1.0
COMPANION_DOWNLOAD_URL=/companion/watchdesk-companion-setup.exe
COMPANION_MANDATORY=false
```

Publicar o instalador em `deploy/companion/` (montado em `/opt/companion` no Caddy).
