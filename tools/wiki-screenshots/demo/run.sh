#!/bin/sh
# Starts the web app on :3100 against the demo database ONLY.
#   sh tools/wiki-screenshots/demo/run.sh          Maple House (db ourhome_demo)
#   sh tools/wiki-screenshots/demo/run.sh blank    empty database, for the setup page
# Every secret is pinned from this folder's .env, so the repo's real .env (whose
# DEV_DATABASE_URL points at the real server) can never win.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-demo}"
case "$MODE" in
  demo) DIR="$HERE"; DB=ourhome_demo ;;
  blank) DIR="$HERE/blank"; DB=ourhome_blank ;;
  *) echo "usage: run.sh [demo|blank]"; exit 1 ;;
esac
URL="mongodb://localhost:27019/$DB?replicaSet=rs0&directConnection=true"

echo "checking the demo database container"
if [ "$(docker inspect -f '{{.State.Running}}' ourhome_demo_mongo 2>/dev/null)" != "true" ]; then
  echo "  ourhome_demo_mongo is not running; starting it"
  docker start ourhome_demo_mongo >/dev/null || { echo "  no container; see README.md to create it"; exit 1; }
  sleep 3
fi
echo "  running"

if [ ! -f "$DIR/.env" ]; then
  echo "no $MODE .env yet; writing one with fresh demo secrets"
  rnd() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
  AUTH="$(rnd 32)"; CRON="$(rnd 16)"
  {
    echo "DATABASE_URL=$URL"; echo "DEV_DATABASE_URL=$URL"
    echo "BETTER_AUTH_SECRET=$AUTH"; echo "DEV_BETTER_AUTH_SECRET=$AUTH"
    echo "CRON_SECRET=$CRON"; echo "DEV_CRON_SECRET=$CRON"
    for k in SMTP_PASS TURNSTILE_SECRET_KEY FIREBASE_SERVICE_ACCOUNT PAPERLESS_TOKEN; do echo "$k="; echo "DEV_$k="; done
  } > "$DIR/.env"
fi

while IFS= read -r line; do [ -n "$line" ] && export "$line"; done < "$DIR/.env"
export SETTINGS_FILE="$DIR/settings.yml" SECRETS_FILE="$DIR/.env"
for v in "$DATABASE_URL" "$DEV_DATABASE_URL"; do
  case "$v" in mongodb://localhost:27019/*|mongodb://127.0.0.1:27019/*) ;; *) echo "REFUSING: a database URL is not the demo one"; exit 1 ;; esac
done
echo "starting demo server on :3100 against $DB (localhost:27019)"
cd "$HERE/../../.."
exec npx next dev -p 3100
