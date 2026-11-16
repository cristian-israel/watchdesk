#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
lock='.deploy-web.lock'
if ! mkdir "$lock" 2>/dev/null; then echo "Outro deploy web está em andamento; verifique $lock." >&2; exit 1; fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM

tag=${1:-main}
if [ "$tag" = "latest" ]; then
  tag="main"
fi

case "$tag" in ''|*[!A-Za-z0-9_.-]*) echo "Tag de imagem inválida." >&2; exit 1 ;; esac
repositorio=${WEB_IMAGE_REPOSITORY:-ghcr.io/cristian-israel/watchdesk-web}
imagem="$repositorio:$tag"
docker pull "$imagem"
id=$(docker create "$imagem")
trap 'docker rm -f "$id" >/dev/null 2>&1 || true; rmdir "$lock" 2>/dev/null || true' EXIT

identificador=$(docker inspect -f '{{.Id}}' "$id" 2>/dev/null | cut -c8-19 || echo "$tag")

atual=$(readlink site/atual 2>/dev/null || true)
if [ "$atual" = "releases/$identificador" ]; then
  nome="$identificador.preparo"
else
  nome="$identificador"
fi
destino="site/releases/$nome"
rm -rf "$destino"
mkdir -p "$destino"
if ! docker cp "$id:/opt/." "$destino" || [ ! -f "$destino/index.html" ]; then
  rm -rf "$destino"
  echo "A imagem não trouxe o site." >&2
  exit 1
fi

ln -sfn "releases/$nome" site/atual.novo
mv -Tf site/atual.novo site/atual

if [ "$nome" = "$identificador" ]; then
  rm -rf "site/releases/$identificador.preparo"
else
  rm -rf "site/releases/$identificador"
fi

echo "Frontend atualizado com sucesso para versão $tag ($identificador)!"
