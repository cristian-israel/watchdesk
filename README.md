# watchdesk

Transmite telas para uma página web protegida por chave (WebRTC). Cada transmissor define a chave dos espectadores da própria sala.

```
apps/web (Vite) ──Caddy──▶ estático
apps/api (Node)  ◀─ /api /whep /whip ─┘
       └─ MediaMTX ◀── WebRTC mídia :8189
```

## Desenvolvimento

Requisitos: **Node 18+**, **pnpm**, `ffmpeg` e `mediamtx` no `PATH` ou em `./bin`.

```bash
pnpm install
pnpm dev          # API :9000 + Vite :9100
```

- Assistir: `http://localhost:9100/sala/casa`
- Transmitir: `http://localhost:9100/host/casa` (localhost ou HTTPS)

| Script | O que faz |
|--------|-----------|
| `pnpm browser` | Só API em modo navegador |
| `pnpm screen` | API com captura ffmpeg (Windows) |
| `pnpm teste` | Vídeo de teste (`demo` / chave `teste123`) |

## Produção

Mesmo modelo do Keeptime: `vps-prod` (túnel) + pasta da instalação com Caddy na rede `edge`. Ver [docs/producao.md](docs/producao.md).

```bash
pnpm deploy:web
pnpm deploy:api
# na VPS: sudo ./scripts/atualizar-web.sh <sha>
#         sudo ./scripts/atualizar-api.sh <sha>
```

## Apps

| App | Papel |
|-----|--------|
| `apps/api` | MediaMTX, auth por sala, proxy WHEP/WHIP |
| `apps/web` | SPA React |
