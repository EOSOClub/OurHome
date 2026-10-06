# Deploying Our Home with Docker

This folder is a **template**. Copy it to `docker/` (gitignored). Settings
live in the single repo-root `.env` (also gitignored), the same file local dev
uses. You never edit the files in `docker/`; all configuration is in `.env`.

## Quick start on a server

Prerequisites: Docker with Compose v2, and a MongoDB **replica set** the server
can reach (see [What runs](#what-runs)).

```bash
git clone https://github.com/EOSOClub/OurHome.git
cd OurHome
cp -r docker.example docker
cp .env.example .env
nano .env                   # fill in every value (see step 1 below)
cd docker
./deploy.sh --seed          # --seed only on an empty database
```

### Updating

`git pull` updates the code and this template, but not your `docker/` copy.
Since nothing in `docker/` is hand-edited, refresh it from the template:

```bash
cd OurHome
git pull
cp -r docker.example/. docker/
cd docker
./deploy.sh
```

Compare `.env.example` with your `.env` after a pull, in case new settings were
added.

## What runs

Just the web app (`web`). On start it applies the database schema
(`prisma db push`) and serves on `127.0.0.1:3000`. It also runs the reminder
sweep every 15 minutes, so overdue / low-stock / bill-due notifications stay
current without anything else running.

**You provide MongoDB.** It must be a **replica set**, because the app uses
transactions. A single-node replica set is fine. Run it however you like (its
own Docker stack, a managed service, …) and point `SERVER_DATABASE_URL` at it.

The web container joins the Docker network named by `DOCKER_NETWORK` (default
`ourhome_net`; the deploy scripts create it if missing). If MongoDB runs as a
container, attach it to the same network and use its container name or alias as
the host in `SERVER_DATABASE_URL`, e.g. `mongodb://…@mongo:27017/household?replicaSet=rs0&authSource=admin`.
Any other service the app should reach by name goes on that network too.

## 1. Fill in `.env`

Every setting is explained in [`.env.example`](../.env.example). The compose
file loads `../.env` into the container and swaps in the server-only values:
`SERVER_DATABASE_URL` becomes `DATABASE_URL`, `PUBLIC_URL` becomes
`BETTER_AUTH_URL`, `SERVER_SMTP_HOST` becomes `SMTP_HOST`, and
`SERVER_TURNSTILE_*` become `TURNSTILE_*`. At minimum:

- `SERVER_DATABASE_URL` — your MongoDB replica set.
- `DOCKER_NETWORK` — the network your MongoDB container is on (if it is one).
- `PUBLIC_URL` and `BETTER_AUTH_TRUSTED_ORIGINS` — your public URL.
- `BETTER_AUTH_SECRET` and `CRON_SECRET`
  — random hex: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `SEED_*` — the household name and first users.

## 2. Start it

```bash
cd docker
./deploy.sh --seed        # Linux/macOS (bash)
.\deploy.ps1 -Seed        # Windows PowerShell
```

The script checks Docker, creates the `DOCKER_NETWORK` network if needed,
builds and starts the app, waits for it to respond, and (with `--seed`) creates
the household and users. Run it again without `--seed` to redeploy after
updates. Plain compose works too, but must be pointed at the root `.env` (and
the network must already exist): `docker compose --env-file ../.env up -d --build`.

## 3. Put HTTPS in front

`web` only listens on `127.0.0.1`. Use a reverse proxy or tunnel on the same
host (Cloudflare Tunnel, Caddy, nginx, …) pointing at `http://127.0.0.1:3000`,
and make sure the public URL matches `PUBLIC_URL`. Session cookies are
HTTPS-only.

## Optional

- **Email** — set `SERVER_SMTP_HOST` and `SMTP_*` (any SMTP provider).
  `CONTACT_FORWARD_TO` receives contact-form messages; `BUG_REPORT_EMAIL`
  receives bug reports. Unset = stored in the app but not emailed.
- **Contact-form CAPTCHA** — `SERVER_TURNSTILE_SITE_KEY` /
  `SERVER_TURNSTILE_SECRET_KEY` (Cloudflare Turnstile).
- **Home Assistant display** — create a token on the site (Settings → Home
  Assistant connection), then see `../HomeAssistant/display.yaml`.
- **Trigger a reminder sweep now** —
  `curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/reminders`

## Backups

All data is in your MongoDB (the `household` database), so back that up, e.g.
with `mongodump`. The web container keeps no state.
