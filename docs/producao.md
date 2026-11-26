# Produção

Um servidor, um domínio por instalação. HTTP entra pelo porteiro do `prod-hub` (**alias** na LAN e/ou **túnel** Cloudflare); no host ficam as portas do **Coturn** (IP LAN ou público, conforme o cenário). Estado das salas fica no **MySQL**: o da rede `infra` do prod-hub, ou o deste Compose quando o profile `mysql` está ativo.

## LAN (caminho feliz interno)

Empresa: PCs alcançam o servidor; sem exposição na internet.

| | |
| --- | --- |
| Hub | `COMPOSE_PROFILES=alias,...` (sem `tunnel` para este app) |
| Site | `alias/sites/*.caddy` + TLS DNS Cloudflare (Let's Encrypt) |
| DNS | registro A (nuvem cinza) → IP privado do servidor |
| App | `COMPOSE_PROFILES=frontier`, `DOMAIN=http://<FRONTIER_ALIAS>` (igual Giga/Keeptime) |
| URL do site | só no prod-hub (`alias/sites` ou túnel) — convites no front com `location.origin` |
| `PUBLIC_HOST` | IP **LAN** do servidor (Coturn / ICE; peculiaridade WebRTC) |

O alias reescreve `Host` para o `FRONTIER_ALIAS` e manda `X-Forwarded-Host` com o DNS; a API usa isso no WebSocket. Firewall: 80/443 e TURN só na interface LAN.

## Modelo comum

```text
VPS
  prod-hub/                 ← túnel + rede Docker frontier
  {produto}/                ← /opt/watchdesk
      compose.yaml
      .env
      caddy/
      turn/
      scripts/
      site/
```

Contrato compartilhado com o Keeptime: túnel só no prod-hub; Caddy em `frontier` (ou `local`) com `FRONTIER_ALIAS` e `DOMAIN=http://<FRONTIER_ALIAS>`; blue/green fora do `COMPOSE_PROFILES`; scripts `subir.sh` e `atualizar-*.sh`.

## Peculiaridades deste produto

| | Watchdesk |
| --- | --- |
| Banco | MySQL na infra do hub, ou profile `mysql` neste Compose |
| Sessão | Cookie httpOnly `wd_session` (7 dias); F5 não pede chave de novo |
| Porta API | `7030` (HTTP + WS via Caddy) |
| Portas no host | **3478** TCP+UDP + **50100–50200** UDP (TURN) |
| Caddy | proxy `/api` (inclui WS); resto = SPA; imagem `caddy:2-alpine` |
| Mídia | WebRTC P2P; Coturn só se P2P falhar |

```text
navegador
  → https://watchdesk.dominio.com
    → túnel → Caddy → API :7030 (/api, /api/ws)
  → P2P host ↔ viewer
  → TURN PUBLIC_HOST:3478 (fallback)
```

No túnel, o serviço é `http://<FRONTIER_ALIAS>:80` e o HTTP Host Header é `<FRONTIER_ALIAS>`. Sem esse header o Caddy não casa `DOMAIN`.

## MySQL

Caminho feliz: database no MySQL da rede `infra` e `COMPOSE_PROFILES=frontier` (sem profile `mysql`). A API já entra nessa rede.

```text
DATABASE_URL=mysql://watchdesk:SENHA_FORTE@mysql:3306/watchdesk
```

O host `mysql` é o serviço do prod-hub. Migrations rodam sozinhas no boot da API.

Schema atual (`001_init.sql`) é instalação limpa (salas por link, sem chaves). Se o database já existia com o schema antigo, drope e recrie o database `watchdesk` antes de subir a API nova.

Para um MySQL só deste Compose, use `COMPOSE_PROFILES=frontier,mysql` (ou `local,mysql` no lab) e defina `MYSQL_PASSWORD`. Sem `DATABASE_URL`, o Compose aponta para `mysql://watchdesk:<senha>@mysql:3306/watchdesk` do serviço local. Crie o database na infra com:

```sql
CREATE DATABASE watchdesk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'watchdesk'@'%' IDENTIFIED BY 'SENHA_FORTE';
GRANT ALL ON watchdesk.* TO 'watchdesk'@'%';
FLUSH PRIVILEGES;
```

## TURN / firewall

- `PUBLIC_HOST` = IP alcançável pelos peers (LAN ou público)
- `TURN_SECRET` = string longa aleatória
- Firewall: **3478** UDP+TCP e **50100–50200** UDP; no caminho feliz LAN, **80/443** só via `caddy_alias` na rede interna; sem **7031**

## Ambiente

Copie `deploy/.env.example` → `deploy/.env`. Obrigatórios em prod: `FRONTIER_ALIAS`, `DOMAIN=http://<FRONTIER_ALIAS>`, `PUBLIC_HOST`, `TURN_SECRET`. `DATABASE_URL` é obrigatório quando o profile `mysql` não está ativo.

No primeiro boot, se não houver nenhum admin ativo, a API cria um a partir de `ADMIN_LOGIN` / `ADMIN_PASSWORD` / `ADMIN_DISPLAY_NAME` (login sem `@`). Defina senha forte em produção; depois do seed o valor no `.env` não altera admins já existentes.

`PUBLIC_HOST` = IP do Coturn (LAN ou público). A URL HTTPS do site fica só no porteiro do prod-hub.

## Subida

```text
cd /opt/watchdesk
sudo chmod +x scripts/*.sh
sudo mkdir -p site/releases
sudo ./scripts/atualizar-web.sh
sudo ./scripts/subir.sh
```

`subir.sh` lê o slot em `caddy/upstream.caddy` e sobe o Caddy do profile (`frontier` ou `local`). O TURN sobe junto, sem profile.

## Publicar de novo

```text
pnpm deploy:api && pnpm deploy:web
# VPS:
sudo ./scripts/atualizar-api.sh <sha>
sudo ./scripts/atualizar-web.sh <sha>
```
