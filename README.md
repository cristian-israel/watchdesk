# watchdesk

Transmite telas (WebRTC **P2P**), com salas no MySQL, sessão por cookie, chat e TURN só se a conexão direta falhar.

## Desenvolvimento (igual Keeptime)

```bash
cp .env.example .env          # DATABASE_URL aponta para 127.0.0.1:3306
pnpm install
pnpm db:up                    # sobe MySQL local (Docker)
pnpm dev                      # API :7030 + Vite :7130
```

- Salas: http://localhost:7130/salas (cria sala com id opaco + link `#k=…`)  
- Assistir: cole o link de convite em http://localhost:7130/ (ou abra `/sala/{id}#k=…`)  
- Transmitir: http://localhost:7130/salas/{id}  

O `.env` na raiz do repo é lido pela API (via `dotenv`), como no Keeptime. Migrations rodam no boot da API.

Se a porta **3306** já estiver ocupada (ex.: MySQL do Keeptime), ou pare o outro Compose, ou reutilize esse MySQL criando o database/user `watchdesk` e mantendo o mesmo `DATABASE_URL`.

```bash
pnpm db:down                  # para o MySQL local
```

## Produção

Ver [docs/producao.md](docs/producao.md). Em produção o MySQL é o da rede `infra` do prod-hub, ou o profile `mysql` do Compose de deploy.

## Companion (controle remoto)

Ver [docs/controle-remoto.md](docs/controle-remoto.md) e [apps/companion/README.md](apps/companion/README.md).

```bash
cd apps/companion && pnpm install --ignore-workspace && pnpm pack:linux
./deploy/scripts/publicar-companion.sh
# rsync deploy/companion/ → /opt/watchdesk/companion/
```

Na LAN: `/companion/watchdesk-companion.AppImage` (Linux) ou `.exe` (Windows).
