#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
lock='.backup.lock'
if ! mkdir "$lock" 2>/dev/null; then
  echo "Outro backup está em andamento; verifique $lock." >&2
  exit 1
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM

ler_env() {
  grep -E "^[[:space:]]*$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d ' "\r'\''' || true
}

projeto=$(ler_env COMPOSE_PROJECT_NAME)
projeto="${projeto:-$(basename "$(pwd)")}"
infra_network=$(ler_env INFRA_NETWORK)
infra_network="${infra_network:-infra}"
timestamp=$(date +"%Y%m%d_%H%M%S")
destino="backups/${timestamp}"
mkdir -p "$destino"

database_url=$(ler_env DATABASE_URL)
mysql_password=$(ler_env MYSQL_PASSWORD)
if [ -z "$database_url" ]; then
  database_url="mysql://watchdesk:${mysql_password}@mysql:3306/watchdesk"
fi

# mysql://user:pass@host:port/db  → user, pass, host, port, db
db_user=$(printf '%s' "$database_url" | sed -n 's|^mysql://\([^:]*\):.*|\1|p')
db_pass=$(printf '%s' "$database_url" | sed -n 's|^mysql://[^:]*:\([^@]*\)@.*|\1|p')
db_host=$(printf '%s' "$database_url" | sed -n 's|^mysql://[^@]*@\([^:/]*\).*|\1|p')
db_port=$(printf '%s' "$database_url" | sed -n 's|^mysql://[^@]*@[^:/]*:\([0-9]*\).*|\1|p')
db_name=$(printf '%s' "$database_url" | sed -n 's|^mysql://[^/]*/\([^?]*\).*|\1|p')
db_port="${db_port:-3306}"
db_name="${db_name:-watchdesk}"

echo "==> Dump do MySQL (${db_name}) em ${destino}/mysql.sql.gz..."
cid=$(docker compose ps -q mysql 2>/dev/null || true)
if [ -n "$cid" ]; then
  if ! docker compose exec -T mysql sh -c 'mysqladmin ping -h localhost -uroot -p"$MYSQL_ROOT_PASSWORD"' >/dev/null 2>&1; then
    echo "MySQL local não respondeu ao ping." >&2
    exit 1
  fi
  docker compose exec -T mysql sh -c \
    "mysqldump -uroot -p\"\$MYSQL_ROOT_PASSWORD\" --single-transaction --no-tablespaces --routines --triggers \"$db_name\"" \
    | gzip > "${destino}/mysql.sql.gz"
else
  if [ -z "$db_user" ] || [ -z "$db_host" ]; then
    echo "MySQL local parado e DATABASE_URL inválida; não há como fazer dump." >&2
    exit 1
  fi
  docker run --rm --network "$infra_network" \
    -e MYSQL_PWD="$db_pass" \
    mysql:8.4 \
    mysqldump -h"$db_host" -P"$db_port" -u"$db_user" \
      --single-transaction --no-tablespaces --routines --triggers "$db_name" \
    | gzip > "${destino}/mysql.sql.gz"
fi

echo "==> Removendo backups com mais de 30 dias..."
find backups -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +

echo "Backup concluído: ${destino}"
echo "  - mysql.sql.gz"
echo "Copie esta pasta para fora da VPS."

