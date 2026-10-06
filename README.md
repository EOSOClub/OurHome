# Our Home

A self-hosted, mobile-first household operations platform: tasks and chores
(with recurrence and checklists), shopping lists, inventory with restock
forecasting and NFC tags, bills and payments, a calendar, household requests
(movies/TV and maintenance with deadlines), in-app notifications and reminders,
bug reports, and role-based access for every member of the household.

There's a companion Android app — **[OurHomeApp](https://github.com/EOSOClub/OurHomeApp)** —
that talks to this site's API (NFC tag scanning, notifications, everything above).

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the design and
[`docs/`](./docs) for runbooks (permissions, NFC tags, Home Assistant).

## Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **TailwindCSS v4** + shadcn-style UI components
- **Prisma 6** on **MongoDB** (single-node replica set)
- **Better Auth** (username/password, HTTP-only cookies, roles)
- **TanStack Query**, **Zod**, **Vitest**
- **Docker Compose** for deployment ([`docker.example/`](./docker.example))

## Deploy with Docker

Deployment lives in a `docker/` folder that is **gitignored** — your real
config and secrets never enter the repo. Start from the public template:

```bash
git clone https://github.com/EOSOClub/OurHome.git
cd OurHome
cp -r docker.example docker
cp .env.example .env                   # then edit .env
cd docker
./deploy.sh --seed                     # or: docker compose --env-file ../.env up -d --build
```

Docker runs **only the web app**. Bring your own MongoDB **replica set** and
point `SERVER_DATABASE_URL` at it. The reminder sweep runs inside the app.
`deploy.sh` (or `deploy.ps1` on Windows) builds and starts the app, waits until
it responds, and with `--seed` creates the household and first users from the
`SEED_*` values in `.env`.

Then sign in at `PUBLIC_URL` with `SEED_ADMIN_USERNAME` /
`SEED_ADMIN_PASSWORD`. The web container listens on `127.0.0.1:3000` only — put
a reverse proxy or tunnel (Cloudflare Tunnel, Caddy, nginx…) in front for HTTPS.

Full walkthrough and every setting: [`docker.example/README.md`](./docker.example/README.md).

## Configuration

All configuration lives in one `.env` in the repo root, used by both local dev
and the Docker deploy. Every setting is documented in
[`.env.example`](./.env.example). The compose file loads it into the container
and swaps in the server-only values (`PUBLIC_URL`, `SERVER_*`). The essentials:

| Setting | What it's for |
| --- | --- |
| `APP_NAME` | Name shown in the browser, sign-in page and emails (default "Our Home") |
| `PUBLIC_URL`, `BETTER_AUTH_TRUSTED_ORIGINS` | Your public URL (server) |
| `SERVER_DATABASE_URL` | Your MongoDB replica set, as the container reaches it |
| `BETTER_AUTH_URL`, `DATABASE_URL` | Local dev URL and database |
| `BETTER_AUTH_SECRET` | Session signing secret |
| `CRON_SECRET` | Optional: trigger a reminder sweep via `/api/cron/reminders` |
| `SERVER_SMTP_HOST`, `SMTP_*`, `CONTACT_FORWARD_TO`, `BUG_REPORT_EMAIL` | Optional email (server only) |
| `SERVER_TURNSTILE_*` | Optional contact-form CAPTCHA (server only) |
| `SEED_*` | First-run household and users |

## Local development

```bash
npm install
cp .env.example .env              # set DATABASE_URL to a MongoDB replica set
npm run db:generate
npm run db:push
npm run db:seed
npm run dev                       # http://localhost:3000
```

| Script | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js dev / production build / serve |
| `npm run db:generate` | Generate the Prisma client |
| `npm run db:push` | Apply the schema to Mongo (no SQL migrations on Mongo) |
| `npm run db:seed` | Seed the household, users, categories, sample chores |
| `npm run test` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |

## Home Assistant

Home Assistant can show inventory on a dashboard from a read-only feed
(`/api/integrations/inventory`) — see
[`HomeAssistant/display.yaml`](./HomeAssistant/display.yaml) and
[`docs/home-assistant.md`](./docs/home-assistant.md). NFC scanning itself now
happens in the Android app.

## Project layout

```
src/
  app/(auth)/…            Sign-in, forgot/reset password
  app/(app)/…             Dashboard, tasks, shopping, inventory, bills, calendar,
                          requests, members, settings, notifications, profile
  app/api/…               Thin route handlers -> services (+ webhooks, cron)
  server/services/        Business logic (only layer touching Prisma)
  server/auth/            Better Auth config + session helpers
  server/api/http.ts      Auth + permissions + validation + rate-limit wrapper
  lib/                    Zod schemas, enums, DTOs, permissions, helpers
  components/             UI primitives + feature components
prisma/                   Schema (models + mongodb datasource)
scripts/                  seed.ts
docker.example/           Deployment template (copy to docker/, which is gitignored)
HomeAssistant/            Example Home Assistant config
docs/                     Runbooks
```
