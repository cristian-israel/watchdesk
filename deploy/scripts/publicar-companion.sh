#!/bin/sh
# Copia artefatos do companion (dist/) para deploy/companion/ e atualiza latest.json.
set -eu
cd "$(dirname "$0")/.."
root="$(cd .. && pwd)"
dist="$root/apps/companion/dist"
out="./companion"
ver=$(node -p "require('$root/apps/companion/package.json').version")

mkdir -p "$out"

win=""
linux=""
if [ -f "$dist/watchdesk-companion-setup.exe" ]; then
  cp -f "$dist/watchdesk-companion-setup.exe" "$out/"
  win="/companion/watchdesk-companion-setup.exe"
fi
# electron-builder AppImage: watchdesk-companion-0.1.0.AppImage
for f in "$dist"/watchdesk-companion-*.AppImage; do
  if [ -f "$f" ]; then
    base=$(basename "$f")
    cp -f "$f" "$out/$base"
    # symlink estável para URL fixa
    ln -sfn "$base" "$out/watchdesk-companion.AppImage"
    linux="/companion/watchdesk-companion.AppImage"
    break
  fi
done

if [ -z "$win" ] && [ -z "$linux" ]; then
  echo "Nenhum artefato em apps/companion/dist. Rode: cd apps/companion && pnpm pack:linux (ou pack:win)" >&2
  exit 1
fi

node -e "
const fs=require('fs');
const prev=JSON.parse(fs.readFileSync('$out/latest.json','utf8'));
const next={
  version: '$ver',
  minVersion: prev.minVersion || '$ver',
  downloadUrl: '$win' || prev.downloadUrl || '/companion/watchdesk-companion-setup.exe',
  downloadUrlLinux: '$linux' || '/companion/watchdesk-companion.AppImage',
  notes: prev.notes || 'Companion Watchdesk',
  mandatory: !!prev.mandatory,
};
fs.writeFileSync('$out/latest.json', JSON.stringify(next, null, 2) + '\n');
console.log(JSON.stringify(next, null, 2));
"

echo "==> Publicado em $out (versão $ver)"
echo "    No servidor: rsync deploy/companion/ e reload do caddy se precisar."
