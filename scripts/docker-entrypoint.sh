#!/bin/sh
# Container start: bring the database schema up to date, optionally seed the demo clinic, start.
set -eu
cd /app
echo "[nightingale] applying database schema to ${DATABASE_URL}"
npx prisma db push --skip-generate
if [ "${NIGHTINGALE_SEED_DEMO:-false}" = "true" ]; then
  echo "[nightingale] seeding the demo clinic (NIGHTINGALE_SEED_DEMO=true)"
  npx prisma db seed
fi
exec npx next start -p "${PORT:-3000}" -H 0.0.0.0
