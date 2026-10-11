#!/bin/sh
# Creates the collections and indexes in the demo database (prisma db push).
# Points Prisma at this folder's settings and .env: prisma.config.ts loads the
# secrets file over the environment, so a plain DATABASE_URL=... would lose to
# the repo's real .env.
#   sh tools/wiki-screenshots/demo/push-schema.sh [demo|blank]
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${1:-demo}" in demo) DIR="$HERE" ;; blank) DIR="$HERE/blank" ;; *) echo "usage: push-schema.sh [demo|blank]"; exit 1 ;; esac
[ -f "$DIR/.env" ] || { echo "no $DIR/.env; run demo/run.sh once first (Ctrl+C after it starts)"; exit 1; }
export SETTINGS_FILE="$DIR/settings.yml" SECRETS_FILE="$DIR/.env"
for k in DATABASE_URL DEV_DATABASE_URL; do
  v="$(grep "^$k=" "$DIR/.env" | cut -d= -f2-)"
  case "$v" in mongodb://localhost:27019/*|mongodb://127.0.0.1:27019/*) echo "$k -> $(echo "$v" | cut -d/ -f3-4 | cut -d'?' -f1)" ;; *) echo "REFUSING: $k is not the demo database"; exit 1 ;; esac
done
cd "$HERE/../../.."
echo "pushing the schema"
npx prisma db push
echo "done"
