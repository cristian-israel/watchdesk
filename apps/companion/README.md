# Watchdesk Companion

Console do **host** no PC do agente: salas, convite, transmissão e controle remoto (promover / revogar). Quem assiste continua no navegador.

## Requisitos

| SO | Captura | Input |
| --- | --- | --- |
| Windows 10+ | Electron `desktopCapturer` | user32 / SendKeys |
| Linux (X11) | Electron `desktopCapturer` | **xdotool** no PATH |

## Uso (agente)

1. Baixe o AppImage / `.exe` em `https://<host>/companion/…` (ou Início na web).
2. Abra o app → origem HTTPS + nome → **Entrar / sincronizar**.
3. **Criar sala** (se ainda não tiver) → **Copiar link espectador**.
4. **Conectar e transmitir** → na lista, **Promover** quem pode interagir.

Não precisa da web para operar. O navegador no mesmo PC é painel opcional.

## Desenvolvimento (NixOS / Linux)

```bash
cd apps/companion
pnpm install
nix-shell -p electron xdotool --run \
  'WATCHDESK_ELECTRON_NO_SANDBOX=1 WATCHDESK_ORIGIN=https://watchdesk-giganet.ilumea.com.br electron . --disable-dev-shm-usage --no-sandbox'
```

## Persistência

Em `userData/companion-settings.json`: origem, nome, cookie do aparelho, última sala/chave.

## Deep link

```text
watchdesk://connect?origin=https://watchdesk-giganet.ilumea.com.br&room=SLUG&transmit=1
```

Opcional: `hostKey=` se for sala de outro aparelho.

## Build / publicar

```bash
pnpm pack:linux   # ou pack:win
../../deploy/scripts/publicar-companion.sh
# rsync deploy/companion/ → /opt/watchdesk/companion/
```

## Regras

- Um publisher por sessão: companion **ou** browser, não os dois.
- Input só para o piloto (`controlMode=interact`).
- Linux: `WATCHDESK_XDOTOOL=/caminho/xdotool` se não estiver no PATH.
