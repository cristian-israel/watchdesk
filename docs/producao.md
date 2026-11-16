# Produção

Um VPS, um domínio por instalação. HTTP entra pelo Cloudflare Tunnel (`vps-prod`); no host ficam as portas do **Coturn**. Estado das salas fica no **MySQL** já existente na VPS (`DATABASE_URL`).

## Modelo comum

```text
VPS
  vps-prod/                 ← túnel + rede Docker edge
  {produto}/                ← /opt/watchdesk
      compose.yaml
      .env
      caddy/
      turn/
      scripts/
      site/
```

Contrato compartilhado com o Keeptime: túnel só no vps-prod; Caddy em `default` + `edge` com `EDGE_ALIAS`; blue/green; scripts `atualizar-*.sh`.

## Peculiaridades deste produto

| | Watchdesk |
| --- | --- |
| Banco | MySQL externo (`DATABASE_URL`) — salas, sessões, chat |
| Sessão | Cookie httpOnly `wd_session` (7 dias); F5 não pede chave de novo |
| Porta API | `7030` (HTTP + WS via Caddy) |
| Portas no host | **3478** TCP+UDP + **50100–50200** UDP (TURN) |
| Caddy | proxy `/api` (inclui WS); resto = SPA |
| Mídia | WebRTC P2P; Coturn só se P2P falhar |

```text
navegador
  → https://watchdesk.dominio.com
    → túnel → Caddy → API :7030 (/api, /api/ws)
  → P2P host ↔ viewer
  → TURN PUBLIC_HOST:3478 (fallback)
```

## MySQL

1. Crie database e usuário (exemplo):

```sql
CREATE DATABASE watchdesk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'watchdesk'@'%' IDENTIFIED BY 'SENHA_FORTE';
GRANT ALL ON watchdesk.* TO 'watchdesk'@'%';
FLUSH PRIVILEGES;
```

2. No `deploy/.env`:

```text
DATABASE_URL=mysql://watchdesk:SENHA_FORTE@HOST:3306/watchdesk
```

`HOST` deve ser alcançável **de dentro do container da API** (nome do serviço Docker na mesma rede, IP da bridge, etc.). Migrations rodam sozinhas no boot da API.

## TURN / firewall

- `PUBLIC_HOST` = IP da VPS
- `TURN_SECRET` = string longa aleatória
- Firewall: **3478** UDP+TCP e **50100–50200** UDP; **80/443** fechadas no host; sem **7031**

## Ambiente

Copie `deploy/.env.example` → `deploy/.env`. Obrigatórios em prod: `EDGE_ALIAS`, `DATABASE_URL`, `PUBLIC_HOST`, `PUBLIC_ORIGIN`, `TURN_SECRET`.

`PUBLIC_HOST` = IP da VPS (TURN). `PUBLIC_ORIGIN` = URL HTTPS do DNS (ex. `https://watchdesk.ilumea.com.br`) — links de convite; o IP não serve atrás do túnel.

## Subida

```text
cd /opt/watchdesk
sudo chmod +x scripts/*.sh
sudo mkdir -p site/releases
sudo docker compose pull
sudo ./scripts/atualizar-web.sh
sudo docker compose --profile blue up -d
sudo docker compose up -d turn
```

## Publicar de novo

```text
pnpm deploy:api && pnpm deploy:web
# VPS:
sudo ./scripts/atualizar-api.sh <sha>
sudo ./scripts/atualizar-web.sh <sha>
```
