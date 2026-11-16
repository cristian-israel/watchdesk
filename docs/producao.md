# Produção

Deploy conteinerizado do watchdesk (Caddy + API blue/green + site estático), no mesmo modelo do starter-monorepo.

## Modelo

```text
VPS
  watchdesk/
    compose.yaml
    .env
    caddy/
    scripts/
    site/          ← releases + symlink atual (criado pelo atualizar-web.sh)
```

- Profiles `blue` / `green` (API)
- Caddy serve o SPA em `site/atual` e faz proxy de `/api`, `/whep`, `/whip`
- WebRTC mídia na porta **8189** (UDP + TCP) publicada pelo container da API ativa
- Sem Mongo/Redis/worker

## Ambiente

Copie `deploy/.env.example` → `deploy/.env`.

- `DOMAIN`: hostname com HTTPS automático, ou `:80` na LAN
- `PUBLIC_HOST`: IP/DNS que os clientes usam no ICE (mesmo host do `DOMAIN`, sem `https://`)
- `COMPOSE_PROFILES=blue` (ou `green` após o primeiro flip)

## Subida

1. `docker login ghcr.io` na VPS
2. Copiar `deploy/` para a pasta da instalação; preencher `.env`
3. Publicar imagens na máquina de dev (`pnpm deploy:api` / `pnpm deploy:web`)
4. Na VPS:

```bash
sudo chmod +x scripts/*.sh
sudo mkdir -p site/releases
sudo ./scripts/atualizar-web.sh
sudo docker compose --profile blue up -d
```

Firewall: **TCP 80/443** e **UDP+TCP 8189**.

## Atualizar

```bash
sudo ./scripts/atualizar-web.sh          # ou :tag
sudo ./scripts/atualizar-api.sh          # troca blue↔green (derruba o slot antigo por causa da 8189)
```

## Notas

- Cada transmissor abre `/host/<sala>`, define **chave do host** e **chave dos espectadores**.
- Espectadores usam `/sala/<sala>` com a chave daquela sala (ou link `#k=`).
- `getDisplayMedia` exige HTTPS (Caddy) ou localhost.
- Captura ffmpeg (`SOURCE=screen`) não roda no container Linux; produção usa `SOURCE=browser`.
