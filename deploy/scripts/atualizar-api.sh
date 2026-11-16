#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
lock='.deploy-api.lock'
if ! mkdir "$lock" 2>/dev/null; then echo "Outro deploy de API está em andamento; verifique $lock." >&2; exit 1; fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM

esperar() {
  slot=$1
  i=0
  while [ "$i" -lt 30 ]; do
    cid=$(docker compose ps -q "api_$slot")
    if [ -z "$cid" ]; then
      return 1
    fi
    estado=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid")
    case "$estado" in
      "running healthy") return 0 ;;
      exited*|dead*|"running unhealthy") return 1 ;;
    esac
    i=$((i + 1))
    sleep 2
  done
  return 1
}

recolher() {
  docker compose --profile "$1" stop "api_$1" 2>/dev/null || true
  docker compose --profile "$1" rm -f "api_$1" 2>/dev/null || true
}

apontar() {
  slot=$1
  anterior=$(cat caddy/upstream.caddy 2>/dev/null || echo "")
  printf 'reverse_proxy api_%s:7030\n' "$slot" > caddy/upstream.caddy
  if ! docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
    printf '%s\n' "$anterior" > caddy/upstream.caddy
    return 1
  fi
}

subir() {
  slot=$1
  if [ "$slot" = blue ]; then
    export API_IMAGE_BLUE="$imagem"
  else
    export API_IMAGE_GREEN="$imagem"
  fi
  docker compose --profile "$slot" pull "api_$slot"
  docker compose --profile "$slot" up -d --force-recreate --no-deps "api_$slot"
}

tag=${1:-main}
if [ "$tag" = "latest" ]; then
  tag="main"
fi

case "$tag" in ''|*[!A-Za-z0-9_.-]*) echo "Tag de imagem inválida." >&2; exit 1 ;; esac
repositorio=${API_IMAGE_REPOSITORY:-ghcr.io/cristian-israel/watchdesk-api}
imagem="$repositorio:$tag"
export API_IMAGE="$imagem"

ativo=$(sed -n 's/^reverse_proxy api_\(blue\|green\):7030$/\1/p' caddy/upstream.caddy 2>/dev/null || echo "")
if [ -z "$ativo" ]; then
  ativo=$(sed -n 's/^reverse_proxy api_\(blue\|green\):9000$/\1/p' caddy/upstream.caddy 2>/dev/null || echo "")
fi

if [ "$ativo" = "blue" ]; then
  proximo="green"
elif [ "$ativo" = "green" ]; then
  proximo="blue"
else
  proximo="blue"
fi

echo "==> Subindo api_$proximo ($tag)..."
subir "$proximo"

echo "==> Aguardando api_$proximo ficar saudável..."
if ! esperar "$proximo"; then
  echo "Falha no healthcheck de api_$proximo. Abortando deploy..." >&2
  recolher "$proximo"
  exit 1
fi

echo "==> Apontando Caddy para api_$proximo..."
if ! apontar "$proximo"; then
  echo "Falha ao recarregar o Caddy." >&2
  exit 1
fi

if [ -n "$ativo" ] && [ "$ativo" != "$proximo" ]; then
  echo "==> Recolhendo api_$ativo..."
  recolher "$ativo"
fi

echo "Deploy da API ($proximo - $tag) concluído."
