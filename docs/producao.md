# Produção

Um VPS, um domínio por instalação. HTTP entra pelo Cloudflare Tunnel (`vps-prod`); a única porta de aplicação no host é a **8189** (WebRTC). O Keeptime e o Watchdesk compartilham o mesmo modelo de deploy; as diferenças de produto estão em [Peculiaridades](#peculiaridades-deste-produto).

O domínio fica registrado na Hostinger. O DNS fica na Cloudflare. A VPS é a da Hostinger.

## Modelo comum

```text
VPS
  vps-prod/                 ← um túnel + rede Docker edge por máquina
  {produto}/                ← uma pasta = uma instalação (ex.: /srv/watchdesk)
      compose.yaml
      .env
      caddy/
      scripts/
      site/
```

Contrato compartilhado com o Keeptime:

- Sem `cloudflared` no Compose do app; túnel só no **vps-prod**
- Caddy nas redes `default` + `edge`, com alias `${EDGE_ALIAS}`
- Profiles `blue` / `green` (API)
- Scripts `atualizar-api.sh` e `atualizar-web.sh` (lock, tag, repositório sobrescritível)
- Ordem: rede `edge` → `vps-prod` → app → Public Hostname `http://<EDGE_ALIAS>:80`
- Nomes em instalações novas: `COMPOSE_PROJECT_NAME` e `EDGE_ALIAS` iguais
- Árvore `deploy/`: `compose.yaml`, `.env`, `caddy/`, `scripts/`, `site/` (criado na VPS)
- Imagens **não** entram no `.env`

## Peculiaridades deste produto

| | Watchdesk |
| --- | --- |
| Banco / estado | Nenhum (salas em memória na API) |
| Porta API | `9000` (só rede interna) |
| Porta no host | **8189** TCP+UDP (mídia WebRTC / ICE) |
| Imagens GHCR | `watchdesk-api` / `watchdesk-web` |
| Caddy | gzip; proxy `/api`, `/whep`, `/whip`; resto = SPA |
| `PUBLIC_HOST` | IP ou DNS direto da VPS para ICE (não o hostname do Tunnel) |
| Fonte padrão | `SOURCE=browser` |
| Limites default | API `512m`; Caddy `256m` |

```text
navegador
  → https://watchdesk.dominio.com     certificado na borda da Cloudflare
    → túnel (vps-prod)                cloudflared, uma vez por VPS
      → rede Docker edge
        → Caddy (EDGE_ALIAS:80)
            /api /whep /whip          API :9000
            o restante                arquivos do Vite
  → UDP/TCP PUBLIC_HOST:8189          mídia WebRTC (fora do túnel)
```

| Processo | Função | Quem alcança |
| --- | --- | --- |
| cloudflared (vps-prod) | Liga a VPS à Cloudflare | Só a Cloudflare |
| Caddy | Front + proxy signaling | Só o túnel, via `EDGE_ALIAS` |
| API | Auth por sala, MediaMTX, WHEP/WHIP | Caddy (HTTP) + browsers na 8189 |

## Domínio

No túnel da VPS (`vps-prod`), o hostname público aponta para `http://<EDGE_ALIAS>:80`. A Cloudflare cria o CNAME do túnel.

Para **WebRTC**, use `PUBLIC_HOST` com o IP da VPS (ou um A **DNS only** / cinza apontando ao IP). O domínio do Tunnel (nuvem laranja) não encaminha UDP 8189.

Firewall: **22** só para admin; **80/443 fechadas** no host (tráfego web via túnel); **8189** UDP+TCP abertas para a mídia.

## Ambiente

O arquivo de produção é `deploy/.env`, copiado de `deploy/.env.example`. Fica ao lado do `compose.yaml`. Não entra no git.

- `COMPOSE_PROJECT_NAME` / `EDGE_ALIAS` — mesmos valores (ex. `watchdesk`)
- Sem `TUNNEL_TOKEN` neste arquivo
- Sem nomes de imagem neste arquivo
- `PUBLIC_HOST` — obrigatório em produção se quiser vídeo pela internet

As imagens no GHCR são `ghcr.io/cristian-israel/watchdesk-api` e `watchdesk-web`. Cada publicação marca `main` e o sha curto do commit. A última linha do `pnpm deploy:*` já é o comando da VPS, com o sha.

## Caddy

Imagem `caddy:2`. A imagem `watchdesk-web` é só o transporte dos arquivos (`busybox` + `dist` em `/srv`). `Caddyfile` e `upstream.caddy` montados da VPS. Site em `site/atual`.

- `/api`, `/whep`, `/whip` → slot da API em `upstream.caddy`
- resto → `site/atual` com fallback `index.html` (React Router)

## Arquivos

| Arquivo | Onde roda | Função |
| --- | --- | --- |
| `deploy/docker/api.Dockerfile` | Dev | Imagem da API (+ ffmpeg/mediamtx) |
| `deploy/docker/web.Dockerfile` | Dev | Pacote estático do site |
| `deploy/caddy/Caddyfile` | VPS | Rotas HTTP |
| `deploy/caddy/upstream.caddy` | VPS | Slot `api_blue` / `api_green` |
| `deploy/scripts/atualizar-api.sh` | VPS | Flip de API (libera 8189 antes) |
| `deploy/scripts/atualizar-web.sh` | VPS | Publica `site/atual` |
| `deploy/compose.yaml` | VPS | API + Caddy + rede `edge` |
| `deploy/.env` | VPS | Nomes, `PUBLIC_HOST`, limites |
| repositório `vps-prod` | VPS | Túnel (`edge`) |

## Subida

1. Ubuntu, Docker Engine oficial (não Snap), SSH por chave, firewall como acima.
2. Suba o **vps-prod** (rede `edge`, `TUNNEL_TOKEN`).
3. `docker login ghcr.io` na máquina de build (write) e na VPS (read).
4. Publique:

```text
pnpm deploy:api
pnpm deploy:web
```

5. Copie `deploy/` para `/srv/watchdesk` (ou outro path). Preencha `.env` (`EDGE_ALIAS`, `PUBLIC_HOST`).
6. No túnel Cloudflare: Public Hostname → `http://<EDGE_ALIAS>:80`.
7. Na VPS:

```text
cd /srv/watchdesk
sudo chmod +x scripts/*.sh
sudo mkdir -p site/releases
sudo docker compose pull
sudo ./scripts/atualizar-web.sh
sudo docker compose --profile blue up -d
```

## Publicar de novo

Nesta máquina:

```text
pnpm deploy:api
pnpm deploy:web
```

Na VPS:

```text
sudo ./scripts/atualizar-api.sh          # ou: ... atualizar-api.sh <sha>
sudo ./scripts/atualizar-web.sh          # ou: ... atualizar-web.sh <sha>
```

A atualização da API **derruba o slot antigo antes** de subir o novo (porta 8189 não pode ficar em dois containers). Há uma janela curta sem mídia — diferente do zero-downtime do Keeptime.

O túnel (`vps-prod`) e o Caddy não são recriados nas publicações de API/web.
