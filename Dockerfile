# syntax=docker/dockerfile:1
# Nightingale production image: Next.js server + Prisma + the operator scripts (admin:create,
# db:backup, seeding), with the SQLite database on the /data volume.
#
# The full Debian image is used on purpose: it already ships libssl 3 (needed by the Prisma query
# engine) and CA certificates, so the build needs no apt mirror and is reproducible offline from
# the npm registry alone. The slim image lacks libssl.

FROM node:22-bookworm AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
# Fetch every Prisma engine at build time (generate: query engine; db push on a throwaway database:
# schema engine), so the container never downloads binaries at startup.
RUN npx prisma generate && DATABASE_URL=file:/tmp/build-check.db npx prisma db push --skip-generate && rm -f /tmp/build-check.db* && npm run build

FROM node:22-bookworm AS runtime
WORKDIR /app
RUN useradd --uid 1001 --create-home nightingale && mkdir -p /data && chown nightingale /data
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    DATABASE_URL=file:/data/nightingale.db
COPY --from=build --chown=nightingale /app /app
USER nightingale
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
