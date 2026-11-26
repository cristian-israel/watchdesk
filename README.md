# watchdesk

Transmite telas (WebRTC **P2P**), com salas no MySQL, contas (admin seed), convidados por apelido, TTL e designação de controlador.

## Desenvolvimento (igual Keeptime)

```bash
cp .env.example .env          # DATABASE_URL + ADMIN_* 
pnpm install
pnpm db:up                    # sobe MySQL local (Docker)
pnpm dev                      # API :7030 + Vite :7130
```

- Entrada: login (conta) ou convidado (apelido)
- Salas (autenticado): http://localhost:7130/salas — slots, TTL, progress
- Link único: `/sala/{id}` — escolhe espectador ou controlador
- Admin: usuários em `/admin/usuarios` (seed via `ADMIN_LOGIN` / `ADMIN_PASSWORD`)

O `.env` na raiz do repo é lido pela API (via `dotenv`). Migrations SQL rodam no boot (`004_auth_rooms.sql` adiciona users, TTL e designação).

Se o MySQL local já tinha o schema antigo, recrie o volume (`pnpm db:down` + apague o volume Docker + `pnpm db:up`).

```bash
pnpm db:down                  # para o MySQL local
```

## Produção

Ver [docs/producao.md](docs/producao.md). Em produção o MySQL é o da rede `infra` do prod-hub, ou o profile `mysql` do Compose de deploy.
