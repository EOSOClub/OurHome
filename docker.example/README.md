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
nano .env                   # database URL + two secrets (see step 1 below)
cd docker
./deploy.sh
```

Then open `http://<server-ip>:3000` from any device on your network and follow
the setup page (see [step 3](#3-first-run-setup)).

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
(`prisma db push`) and serves plain HTTP on port 3000 to your home network. It also runs the reminder
sweep every 15 minutes, so overdue / low-stock / bill-due notifications stay
current without anything else running.

**You provide MongoDB.** It must be a **replica set**, because the app uses
transactions. A single-node replica set is fine. The ready-made stack in
[OurHomeServices](https://github.com/EOSOClub/OurHomeServices/tree/main/mongo)
matches every default here (network `ourhome_net`, host `mongo`, user and
database `household`). Or run it however you like (a managed service, …) and
point `SERVER_DATABASE_URL` at it.

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
- `BETTER_AUTH_SECRET` and `CRON_SECRET`
  — random hex: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `DOCKER_NETWORK` — the network your MongoDB container is on (if it is one).

No accounts go in `.env`; the setup page creates them.

## 2. Start it

```bash
cd docker
./deploy.sh               # Linux/macOS (bash)
.\deploy.ps1              # Windows PowerShell
```

The script checks Docker, creates the `DOCKER_NETWORK` network if needed,
builds and starts the app, waits for it to respond, and prints the addresses to
open it at. Run it again to redeploy after updates. Plain compose works too, but
must be pointed at the root `.env` (and the network must already exist):
`docker compose --env-file ../.env up -d --build`.

## 3. First-run setup

On an empty database every page leads to **setup**. Open the site from the
server itself (`http://localhost:3000`) or any device on the same network
(`http://<server-ip>:3000`), then:

1. **Create the admin.** Pick the household name and the admin's username and
   password (email optional, for password recovery). The admin becomes the
   Head of House and is signed in straight away.
2. **Add the household.** A username and a starting password for each person,
   plus an optional email and a role. They choose their own password on first
   sign-in. You can skip this step and use **Members** later.

After you click **Finish**, the app asks once how the site may be reached:
**Home network and HTTPS**, or **HTTPS only**. "Decide later" asks again next
time. You can change it any time under **Settings → Security** (Head of House
only). HTTPS only refuses sign-in over plain HTTP from every other device, and
signs everyone else out once. Home Assistant and other token-based connections
keep working over HTTP.

> [!TIP]
> **Locked out under HTTPS only?** `http://localhost:3000` on the server itself
> always works (from another machine: `ssh -L 3000:localhost:3000 <server>`,
> then open `http://localhost:3000`). Sign in and switch it back under
> Settings → Security.

Setup only answers while no account exists, and only to devices on the home
network: a request that arrives through a tunnel or reverse proxy from the
internet is refused, so finish setup before (or without) exposing the site.

## 4. Optional: HTTPS from outside

The app works over plain HTTP on your home network. To reach it from anywhere,
put a tunnel or reverse proxy in front (Cloudflare Tunnel, Caddy, nginx, …)
pointing at `http://<server>:3000`, and set `PUBLIC_URL` to its `https://`
address (used for links in emails). Never forward port 3000 on your router.
Over HTTPS the session cookie is marked Secure; on the home network it can't
be, since browsers drop Secure cookies on plain HTTP. Set `WEB_BIND=127.0.0.1`
to stop serving the home network directly and use only the tunnel.

## Optional

- **Email** — set `SERVER_SMTP_HOST` and `SMTP_*` (any SMTP provider).
  `CONTACT_FORWARD_TO` receives contact-form messages; `BUG_REPORT_EMAIL`
  receives bug reports. Unset = stored in the app but not emailed.
- **Contact-form CAPTCHA** — `SERVER_TURNSTILE_SITE_KEY` /
  `SERVER_TURNSTILE_SECRET_KEY` (Cloudflare Turnstile).
- **Home Assistant display** — create a token on the site (Settings → Home
  Assistant connection), then see `../HomeAssistant/display.yaml`.
- **Trigger a reminder sweep now** —
  `curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reminders`

## Backups

All data is in your MongoDB (the `household` database), so back that up, e.g.
with `mongodump`. The web container keeps no state.
