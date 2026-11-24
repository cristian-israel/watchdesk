# Watchdesk Companion

App Electron que transmite a tela e injeta input quando o host promove um espectador a **interagir**.

## Requisitos

| SO | Captura | Input |
| --- | --- | --- |
| Windows 10+ | Electron `desktopCapturer` | user32 / SendKeys |
| Linux (X11) | Electron `desktopCapturer` | **xdotool** no PATH |

- Node 18+
- Sala Watchdesk na LAN (HTTPS)

Pacote **fora** do workspace pnpm raiz. Instale aqui dentro.

## Desenvolvimento (NixOS / Linux)

```bash
cd apps/companion
pnpm install
# NixOS: se o Electron reclamar de sandbox:
export WATCHDESK_ELECTRON_NO_SANDBOX=1
WATCHDESK_ORIGIN=https://watchdesk-giganet.ilumea.com.br pnpm start
```

Dependência de runtime Linux: `xdotool` (ex. `nix-shell -p xdotool` ou pacote do distro).

## Build

```bash
# Linux AppImage (nesta máquina)
pnpm pack:linux

# Windows .exe (precisa Wine ou build em Windows/CI)
pnpm pack:win

# Publicar no deploy local
chmod +x ../../deploy/scripts/publicar-companion.sh
../../deploy/scripts/publicar-companion.sh
```

Artefatos em `deploy/companion/`:

- `watchdesk-companion-setup.exe` (Windows)
- `watchdesk-companion.AppImage` (Linux)
- `latest.json`

No servidor: rsync da pasta `deploy/companion/` → `/opt/watchdesk/companion/` e Caddy já serve `/companion/*`.

## Download na LAN

- Windows: `https://<seu-host>/companion/watchdesk-companion-setup.exe`
- Linux: `https://<seu-host>/companion/watchdesk-companion.AppImage`
- Meta: `https://<seu-host>/api/companion/version` ou `/companion/latest.json`

## Atualização

1. Companion chama `GET /api/companion/version`.
2. Se local &lt; latest → banner + botão Atualizar.
3. `COMPANION_MANDATORY=true` bloqueia transmitir abaixo de `minVersion`.

## Regras

- Um publisher por sessão: com companion ativo, não use “Compartilhar tela” no browser.
- Input só se o peer for o piloto (`controlMode=interact`).
- Botão **Revogar controle** no companion corta o piloto.
