#!/bin/sh
set -e

# Apply the Prisma schema to Mongo (creates collections + indexes). Idempotent,
# so it is safe to run on every boot. Mongo must already be a replica set and
# reachable at DATABASE_URL (it runs outside this compose file).
echo "[entrypoint] prisma db push..."
npx prisma db push --skip-generate

# Run whatever command was given (default CMD is `npm run start`). This lets
# one-off commands work too, e.g. `docker compose run --rm web npm run db:seed`.
echo "[entrypoint] exec: $*"
exec "$@"
