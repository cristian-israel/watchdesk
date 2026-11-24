#!/bin/sh
# Sobe o stack com o slot blue/green ativo (lê caddy/upstream.caddy).
# COMPOSE_PROFILES no .env = só borda/infra (frontier|local, mysql…).
set -eu
cd "$(dirname "$0")/.."

ler_env() {
  grep -E "^[[:space:]]*$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d ' "\r' || true
}

perfis=$(ler_env COMPOSE_PROFILES)
case ",$perfis," in
  *,frontier,*|*,local,*) ;;
  *)
    echo "ERRO: COMPOSE_PROFILES deve conter ao menos 'frontier' ou 'local' (atual: '${perfis:-<vazio>}')." >&2
    exit 1
    ;;
esac

ativo=$(sed -n 's/^reverse_proxy api_\(blue\|green\):[0-9][0-9]*.*/\1/p' caddy/upstream.caddy 2>/dev/null | head -n1 || true)
[ -n "$ativo" ] || ativo=blue

set --
old_ifs=$IFS
IFS=,
for p in $perfis; do
  p=$(printf '%s' "$p" | tr -d ' ')
  [ -n "$p" ] || continue
  set -- "$@" --profile "$p"
done
IFS=$old_ifs
set -- "$@" --profile "$ativo"

echo "==> Slot API: $ativo (COMPOSE_PROFILES=$perfis)"
docker compose "$@" up -d

if [ -z "$(docker compose ps -q caddy 2>/dev/null)$(docker compose ps -q caddy_local 2>/dev/null)" ]; then
  echo "ERRO: Caddy não subiu (frontier/local). Confira compose.yaml e a rede frontier." >&2
  docker compose "$@" ps -a
  exit 1
fi
