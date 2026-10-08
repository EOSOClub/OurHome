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
cd docker
./deploy.sh                 # Windows: .\deploy.ps1
```

The first run creates `settings.yml` and `.env` from their templates and walks
you through every setting: what each one is for, an example of what the value
looks like, and links to the outside accounts (Firebase, Cloudflare Turnstile,
your mail provider). It can also run MongoDB, Paperless-ngx and the Proton Bridge
for you and build the Android app (see below), so with nothing else installed
you only need Docker. Optional parts can be skipped and set up later with
`./deploy.sh -s`; the sign-in keys and every service password are generated.

Then open `http://<server-ip>:3000` from any device on your network and follow
the setup page (see [step 3](#3-first-run-setup)).

### Later runs and options

Each later run asks once **"Change settings before deploying?"** Answer no (the
default) and it deploys straight away; yes walks through the settings again,
with your current values as the defaults (Enter keeps each one).

| Option | PowerShell | What it does |
| --- | --- | --- |
| `-n`, `--no-cache` | `-NoCache` | Rebuild every layer and re-pull the base image. |
| `-l`, `--local` | `-Local` | Build from this checkout instead of GitHub. |
| `-b`, `--branch NAME` | `-Branch NAME` | Build another branch this time. |
| `-s`, `--setup` | `-Setup` | Go straight to the settings walkthrough. |
| `-y`, `--yes` | `-Yes` | Don't ask; just deploy (for scripts and cron). |
| `--no-build` | `-NoBuild` | Just restart (enough after a settings change). |
| `--timeout S` | `-Timeout S` | Seconds to wait for the app to respond (default 180). |

### Where the image is built from

The app is built **from GitHub**: `docker.repo` and `docker.branch` in
`settings.yml` (default: this repo, `main`). Docker fetches the branch itself on
every build and only rebuilds when it has new commits, so a deploy always runs
the pushed code and the server doesn't need to `git pull` for it. Run your own
fork by changing `docker.repo`. `-l` builds from the local checkout instead
(e.g. to try unpushed changes).

### What the walkthrough can run for you

Answer **no** to "Already have …?" and the deploy runs that piece too, from the
[OurHomeServices](https://github.com/EOSOClub/OurHomeServices) stacks (fetched
into `services.path`, default `../OurHomeServices`). Each stack gets its own
`.env` of generated passwords and joins the same Docker network, so everything
reaches everything else by name:

| Piece | What you do | What the deploy does |
| --- | --- | --- |
| **MongoDB** | Nothing | Starts a single-node replica set, creates the app user, writes `DATABASE_URL` |
| **Paperless-ngx** | Pick its port and address | Starts it (with OCR and email-to-PDF), then the [Paperless setup](../docs/paperless-import.md) with its admin login |
| **Proton Mail Bridge** | Log in once (Proton password + 2FA) in the Bridge's own prompt; paid Proton plan | Builds and starts it, reads its mail login, and gives Paperless a mail account on your bills folder |
| **Other mail (IMAP)** | Server, username, app password | Gives Paperless a mail account on your bills folder |
| **Billers** | Their names | A Paperless correspondent each, plus bill / payment tagging by content |

Paperless's admin password is in `<services.path>/paperless/.env`.

### The Android app

Answer yes to **"Build the Android app here?"** and every deploy builds the app
(only when its code or your settings changed), with this server's address and
your Firebase app id built in, and offers it under **Profile → Android app** to
signed-in members. Phones install updates over the old version.

- The build runs in Docker ([`android/Dockerfile`](android/Dockerfile)); the
  first one downloads the Android tools (about 3 GB) and takes ~10 minutes.
- It's signed with this install's own key, made on the first build:
  **`android/release.jks` and `android/keystore.env` (repo root). Back both up.**
  Android only installs an update over an APK signed with the same key; without
  them, everyone has to uninstall, reinstall and sign in again.
- A home-network-only site (`http://192.168.…`) works: the app allows plain
  HTTP for exactly that address and nothing else.
- `android.repo` can also be the path of a local OurHomeApp checkout, to build
  unpushed changes.

### Windows

`deploy.ps1` runs `deploy.sh` through Git Bash (from
[Git for Windows](https://git-scm.com/download/win)) or WSL, with the same
options in PowerShell form (`-Setup`, `-NoCache`, `-Branch dev`, …).

### Updating

`./deploy.sh` already builds the latest commit. `git pull` is only needed for
changes to the deploy scripts and templates themselves; since nothing in
`docker/` is hand-edited, refresh it from the template after a pull:

```bash
cd OurHome
git pull
cp -r docker.example/. docker/
cd docker
./deploy.sh -s              # new settings show up in the walkthrough
```

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

The deploy script's walkthrough does this for you. By hand: secrets go in
`.env` ([`.env.example`](../.env.example)); everything else in
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

The script checks Docker, offers the settings walkthrough, reads the `docker:`
section of `settings.yml`, checks the branch exists, creates the network if
needed, builds and starts the app, waits for it to respond, and prints the
addresses to open it at. Run it again to redeploy after updates. Plain
`docker compose up -d --build` works too, building `main` from GitHub with the
default names and port (and the network must already exist).

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
- **Paperless-ngx bill import** — the walkthrough can set Paperless up for you
  (tags, fields, a read-only user and token, starter workflows and dashboard
  views) with an admin login used once. See [bill import](../docs/paperless-import.md).
- **Instant phone alerts** — a free Firebase project of your own; the
  walkthrough (`./deploy.sh -s`) asks for your app id, links each Firebase page
  and takes the server key. See [push notifications](../docs/push-notifications.md).
- **Home Assistant display** — create a token on the site (Settings → Home
  Assistant connection), then see `../HomeAssistant/display.yaml`.
- **Trigger a reminder sweep now** — with `CRON_SECRET` from `.env`:
  `curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reminders`

## Backups

All data is in your MongoDB (the `household` database), so back that up, e.g.
with `mongodump`. The web container keeps no state. Keep copies of
`settings.yml` and `.env` somewhere safe too (`.env` holds your secrets), and,
if the deploy builds the Android app, `android/release.jks` + `keystore.env`.
Stacks run for you keep their data and `.env` in their own folders under
`services.path`; see each stack's README in OurHomeServices for its backups.
