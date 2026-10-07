# Deploying Our Home with Docker

This folder is a **template**. Copy it to `docker/` (gitignored). Settings live
in the repo-root `settings.yml` and secrets in the repo-root `.env` (both
gitignored, and the same files local dev uses). You never edit the files in
`docker/`.

## Quick start on a server

Prerequisites: Docker with Compose v2, and a MongoDB **replica set** the server
can reach (see [What runs](#what-runs)).

```bash
git clone https://github.com/EOSOClub/OurHome.git
cd OurHome
cp -r docker.example docker
cp settings.example.yml settings.yml
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

Compare `settings.example.yml` and `.env.example` with your files after a
pull, in case new settings were added.

### Moving from an all-in-one `.env`

Older installs kept everything in `.env`. Split it once with Node, from the
repo root: `npm install`, then `npm run settings:migrate`. (No Node on the
server? Run it on your PC with a copy of the server's `.env`, then copy both new
files back.) It writes `settings.yml` (everything that isn't secret) and a new
secrets-only `.env` from the templates, keeps the old file as `.env.old`, and
prints only the names it moved. Delete `.env.old` once the app runs. Then move
anything you had changed in `docker/docker-compose.yml` (project or container
name, network, port binding) into the `docker:` section of `settings.yml`, and
refresh `docker/` as above.

## What runs

Just the web app (`web`). On start it applies the database schema
(`prisma db push`) and serves plain HTTP on port 3000 to your home network. It
also runs the reminder sweep every 15 minutes, so overdue / low-stock /
bill-due notifications stay current without anything else running.

**You provide MongoDB.** It must be a **replica set**, because the app uses
transactions. A single-node replica set is fine. The ready-made stack in
[OurHomeServices](https://github.com/EOSOClub/OurHomeServices/tree/main/mongo)
matches every default here (network `ourhome_net`, host `mongo`, user and
database `household`). Or run it however you like (a managed service, …) and
point `DATABASE_URL` in `.env` at it.

The web container joins the Docker network named by `docker.network` (default
`ourhome_net`; the deploy scripts create it if missing). If MongoDB runs as a
container, attach it to the same network and use its container name or alias as
the host in `DATABASE_URL`, e.g. `mongodb://…@mongo:27017/household?replicaSet=rs0&authSource=admin`.
Any other service the app should reach by name goes on that network too.

## 1. Fill in `.env` and `settings.yml`

Secrets go in `.env` ([`.env.example`](../.env.example)); everything else in
`settings.yml` ([`settings.example.yml`](../settings.example.yml)). At minimum:

- `.env`: `DATABASE_URL` — your MongoDB replica set.
- `.env`: `BETTER_AUTH_SECRET` and `CRON_SECRET`
  — random hex: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `settings.yml`: `docker.network` — the network your MongoDB container is on
  (if it is one).

No accounts go in either file; the setup page creates them.

**How they reach the app.** Compose passes `.env` to the container as
environment variables and hands it `settings.yml` read-only; neither is baked
into the image. The app reads them when it starts, so a change only needs a
restart (`./deploy.sh --no-build`). The `dev:` section and `DEV_` entries are
ignored on the server. The `docker:` section of `settings.yml` (project and
container name, network, port, bind address) is what the deploy scripts give
compose. They read it with a small pinned `yq` container, so nothing needs
installing on the server. The container runs as uid 1000, so keep
`settings.yml` readable by it (e.g. `644`); `.env` is read by compose itself,
so it can stay `600`.

## 2. Start it

```bash
cd docker
./deploy.sh               # Linux/macOS (bash)
.\deploy.ps1              # Windows PowerShell
```

The script checks Docker, reads the `docker:` section of `settings.yml`,
creates the network if needed, builds and starts the app, waits for it to
respond, and prints the addresses to open it at. Run it again to redeploy after
updates. Plain `docker compose up -d --build` works too, with the default names
and port (and the network must already exist).

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

> [!NOTE]
> **Bound to `127.0.0.1`** (`docker.bind`, e.g. because a tunnel on the same
> machine is the only way in)? Then no other device can open the port, and setup
> through the tunnel is refused. Run setup on the server itself, or through an
> SSH tunnel from any PC on the network:
> `ssh -L 3000:localhost:3000 <user>@<server>`, then open `http://localhost:3000`
> (use your `docker.port` if it isn't 3000). The same applies after a database
> wipe: setup appears again and has to be finished this way.

## 4. Optional: HTTPS from outside

The app works over plain HTTP on your home network. To reach it from anywhere,
put a tunnel or reverse proxy in front (Cloudflare Tunnel, Caddy, nginx, …)
pointing at `http://<server>:3000`, and set `better_auth.url` to its
`https://` address (used for links in emails). Never forward port 3000 on your
router. Over HTTPS the session cookie is marked Secure; on the home network it
can't be, since browsers drop Secure cookies on plain HTTP. Set
`docker.bind: 127.0.0.1` to stop serving the home network directly and use only
the tunnel (finish first-run setup before that, or see the note in step 3).

## Optional

- **Email** — fill in `smtp:` in `settings.yml` and `SMTP_PASS` in `.env` (any
  SMTP provider). `contact.forward_to` receives contact-form messages;
  `bug_report.email` receives bug reports. Unset = stored in the app but not
  emailed.
- **Contact-form CAPTCHA** — `turnstile.site_key` in `settings.yml` and
  `TURNSTILE_SECRET_KEY` in `.env` (Cloudflare Turnstile).
- **Home Assistant display** — create a token on the site (Settings → Home
  Assistant connection), then see `../HomeAssistant/display.yaml`.
- **Trigger a reminder sweep now** — with `CRON_SECRET` from `.env`:
  `curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reminders`

## Backups

All data is in your MongoDB (the `household` database), so back that up, e.g.
with `mongodump`. The web container keeps no state. Keep copies of
`settings.yml` and `.env` somewhere safe too (`.env` holds your secrets).
