# Produção

Um VPS, um domínio por instalação. HTTP entra pelo Cloudflare Tunnel (`prod-hub`); no host ficam as portas do **Coturn**. Estado das salas fica no **MySQL**: o da rede `infra` do prod-hub, ou o deste Compose quando o profile `mysql` está ativo.

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

Para um MySQL só deste Compose, use `COMPOSE_PROFILES=frontier,mysql` (ou `local,mysql` no lab) e defina `MYSQL_PASSWORD`. Sem `DATABASE_URL`, o Compose aponta para `mysql://watchdesk:<senha>@mysql:3306/watchdesk` do serviço local. Crie o database na infra com:

```sql
CREATE DATABASE watchdesk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'watchdesk'@'%' IDENTIFIED BY 'SENHA_FORTE';
GRANT ALL ON watchdesk.* TO 'watchdesk'@'%';
FLUSH PRIVILEGES;
```

## TURN / firewall

- `PUBLIC_HOST` = IP da VPS
- `TURN_SECRET` = string longa aleatória
- Firewall: **3478** UDP+TCP e **50100–50200** UDP; **80/443** fechadas no host; sem **7031**

## Ambiente

Copie `deploy/.env.example` → `deploy/.env`. Obrigatórios em prod: `FRONTIER_ALIAS`, `DOMAIN=http://<FRONTIER_ALIAS>`, `PUBLIC_HOST`, `PUBLIC_ORIGIN`, `TURN_SECRET`. `DATABASE_URL` é obrigatório quando o profile `mysql` não está ativo.

`PUBLIC_HOST` = IP da VPS (TURN). `PUBLIC_ORIGIN` = URL HTTPS do DNS (ex. `https://watchdesk.ilumea.com.br`) — links de convite; o IP não serve atrás do túnel.

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
