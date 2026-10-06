# Next.js household platform — build + run, with the Prisma CLI kept in the
# runtime image so the entrypoint can `prisma db push` against a fresh Mongo.
# Debian-slim (not alpine) to match the Prisma engine binaryTarget
# debian-openssl-3.0.x declared in prisma/schema/models.prisma.

# ---- deps: install all dependencies (incl. devDeps: prisma CLI, tsx) ----
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# `npm install` (not `npm ci`): the lockfile is generated on the dev OS (Windows),
# and Tailwind v4 / Prisma pull OS-specific optional native binaries, so a strict
# `npm ci` fails on Linux. install resolves the correct Linux deps from the lockfile.
RUN npm install --no-audit --no-fund

# ---- build: generate Prisma client + build Next ----
FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `npm run build` runs prebuild (prisma generate) then next build.
RUN npm run build

# ---- runner: full app + node_modules (so prisma CLI / tsx are available) ----
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Run as the unprivileged `node` user (uid 1000, ships with the image). Own the
# app dir so `prisma db push` and `next start` can write caches; if the app is
# ever compromised the process is not root inside the container.
COPY --from=build --chown=node:node /app ./
COPY docker/web/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "run", "start"]
