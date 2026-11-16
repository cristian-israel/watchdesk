# Produção

Deploy conteinerizado do watchdesk (Caddy + API blue/green + site estático), alinhado ao `vps-prod` (Cloudflare Tunnel na rede `edge`).

## Modelo

```text
VPS
  /srv/vps-prod/            ← cloudflared (rede edge) + opcional MySQL/Redis/Mongo (infra)
  /srv/watchdesk/           ← esta instalação
    compose.yaml
    .env
    caddy/
    scripts/
    site/                   ← releases + symlink atual (atualizar-web.sh)
```

```text
Internet → Cloudflare Tunnel → cloudflared (edge) → watchdesk-caddy:80
                                                      ├─ SPA (site/atual)
                                                      └─ /api /whep /whip → api_blue|green:9000
Browser  ── WebRTC mídia UDP/TCP 8189 ──────────────→ api (publicado no host)
```

- Profiles `blue` / `green` (API)
- Caddy **não** publica 80/443; só entra na rede externa `edge` (alias `watchdesk-caddy`)
- Mídia WebRTC: **8189** TCP+UDP no host (o Tunnel não substitui UDP bem)
- Sem Mongo/Redis/worker

## Pré-requisito: vps-prod

```bash
cd /srv/vps-prod
./scripts/criar-rede.sh    # redes edge + infra
docker compose up -d       # cloudflared com TUNNEL_TOKEN
```

No painel do túnel (Cloudflare Zero Trust), Public Hostname → origem:

```text
http://watchdesk-caddy:80
```

## Ambiente

Copie `deploy/.env.example` → `.env` na pasta da instalação (`/srv/watchdesk`).

- `DOMAIN=:80` — TLS na Cloudflare; Caddy só HTTP interno
- `PUBLIC_HOST` — hostname ou IP que o cliente usa no ICE (e que alcança a **8189**)
- `COMPOSE_PROFILES=blue` (ou `green` após o primeiro flip)

## Subida

1. `docker login ghcr.io` na VPS  
2. Conteúdo de `deploy/` em `/srv/watchdesk`; preencher `.env`  
3. Publicar imagens no PC de dev (`pnpm deploy:api` / `pnpm deploy:web`)  
4. Na VPS:

```bash
cd /srv/watchdesk
sudo chmod +x scripts/*.sh
sudo mkdir -p site/releases
sudo ./scripts/atualizar-web.sh
sudo docker compose --profile blue up -d
```

Firewall do host: **UDP + TCP 8189** (não precisa abrir 80/443 para o watchdesk).

## Atualizar

```bash
sudo ./scripts/atualizar-web.sh          # ou tag/sha
sudo ./scripts/atualizar-api.sh          # flip blue↔green (derruba o slot antigo por causa da 8189)
```

## Notas

- Cada transmissor abre `/host/<sala>`, define chave do host e dos espectadores.
- Espectadores usam `/sala/<sala>` (HTTPS via Cloudflare → `getDisplayMedia` ok).
- Captura ffmpeg (`SOURCE=screen`) não roda no container Linux; produção usa `SOURCE=browser`.
