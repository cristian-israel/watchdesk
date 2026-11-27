#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

printf "\033[1;31mATENÇÃO:\033[0m Isso apaga dados dos serviços LOCAIS deste Compose (volume mysql).\n"
printf "Bancos no prod-hub (rede infra) NÃO são apagados automaticamente.\n"
printf "Deseja realmente continuar? (s/N): "
read -r confirmacao

case "$confirmacao" in
  s|S|sim|SIM|Sim)
    ;;
  *)
    echo "Operação cancelada."
    exit 0
    ;;
esac

printf "Deseja realizar um BACKUP antes de limpar? (S/n): "
read -r backup_confirm

case "$backup_confirm" in
  n|N|nao|NAO|Nao|não|NÃO|Não)
    echo "==> Pulando backup."
    ;;
  *)
    ./scripts/backup.sh
    ;;
esac

ler_env() {
  grep -E "^[[:space:]]*$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d ' "\r'\''' || true
}

projeto=$(ler_env COMPOSE_PROJECT_NAME)
projeto="${projeto:-$(basename "$(pwd)")}"
profiles=$(ler_env COMPOSE_PROFILES)

tem_profile() {
  printf '%s' "$profiles" | tr ',' '\n' | grep -qx "$1"
}

echo "==> Parando API e MySQL local (Caddy continua no ar; o túnel fica no prod-hub)..."
docker compose --profile blue --profile green stop api_blue api_green 2>/dev/null || true

if tem_profile mysql || tem_profile local; then
  docker compose stop mysql 2>/dev/null || true
  docker compose rm -f mysql 2>/dev/null || true
  echo "==> Removendo volume local do MySQL..."
  docker volume rm -f "${projeto}_mysql_data" 2>/dev/null || true

  echo "==> Subindo MySQL local limpo..."
  docker compose --profile mysql up -d mysql

  echo "==> Aguardando MySQL local ficar saudável..."
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q mysql 2>/dev/null)" 2>/dev/null)" = "healthy" ]; do
    sleep 2
  done
  sleep 5
else
  echo "==> MySQL não está no COMPOSE_PROFILES (provavelmente prod-hub)."
  echo "    Limpe o schema manualmente no mysql da infra se precisar de banco vazio."
fi

echo "==> Restaurando serviço da API..."
alvo=$(sed -n 's/^reverse_proxy api_\(blue\|green\):7030.*/\1/p' caddy/upstream.caddy 2>/dev/null | head -n1 || echo "blue")
if [ -z "$alvo" ]; then
  alvo="blue"
fi

docker compose --profile "$alvo" up -d "api_$alvo"

echo "\033[1;32mSucesso:\033[0m Limpeza dos dados locais concluída e API restaurada!"

