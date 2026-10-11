# Wiki screenshots

Takes the web app screenshots used in the [OurHome wiki](https://github.com/EOSOClub/OurHome/wiki) from **Maple House**, a made-up demo household. Nothing here touches a real database: the demo runs against its own MongoDB container, and `demo/run.sh` refuses to start if any database URL points anywhere else.

> [!WARNING]
> Don't start the demo with `npm run dev`. Next.js loads the repo's own `.env`, whose `DEV_DATABASE_URL` points at the real server. Always use `demo/run.sh`.

## Retaking screenshots

1. Start the demo server (this also starts the database container if it's stopped):
   ```sh
   sh tools/wiki-screenshots/demo/run.sh
   ```
   Wait for `Ready`, then check http://localhost:3100 shows the Maple House sign-in.
2. Take the screenshots (first time only: `npm install` in `shots/`). Chrome must be installed.
   ```sh
   cd tools/wiki-screenshots/shots
   node shots.js                      # all 31 shots, into shots/out/
   node shots.js bills-overview.png   # or just the ones named
   node sheet2.js                     # contact sheets of out/, to look them over quickly
   ```
3. Copy them into the wiki. This copies every shot listed in `place.py` into the wiki's `images/` folder, and replaces any matching `IMAGE PLACEHOLDER` block with the image and its alt text:
   ```sh
   python place.py <path to OurHome.wiki> out
   ```
4. Stop the server (Ctrl+C) and the database: `docker stop ourhome_demo_mongo`.

The first-run setup page needs an empty database: run `sh demo/run.sh blank`, then `node shots/setup-shot.js` (it fills the form but never submits it).

## Demo accounts

Every member's password is `DemoHouse!2026`: `alex` (Head of House), `sam` (Manager), `jordan` (Member), `riley` (Teen), `mia` (Child). `demo/accounts.md` lists the ids of the bills, tasks and other records the shots open.

## Rebuilding the demo from scratch

Only needed if the container is gone. The seed scripts drive the app's own API, so the data passes the same rules as real use.

```sh
docker run -d --name ourhome_demo_mongo -p 127.0.0.1:27019:27017 mongo:7 --replSet rs0
docker exec ourhome_demo_mongo mongosh --quiet --eval 'rs.initiate()'
sh tools/wiki-screenshots/demo/push-schema.sh
```

Use `push-schema.sh`, never `npx prisma db push` with `DATABASE_URL=...` in front: the Prisma config loads the repo's `.env` over the environment, which would point it at the real server. (If `demo/.env` doesn't exist yet, run `demo/run.sh` once to create it.) Then start `demo/run.sh`, create the household on the setup page (Maple House, `alex`, time zone America/Chicago), and run the seed scripts in order from `demo/seed/`: `01-household`, `01b-places-cats`, `02-tasks`, `03-rest`, `04-bill-dues`, `09-backdate`, `10-reminders` (`node 01-household.mjs`, and so on). They save ids and sign-ins in `seed/state.json`.

The seed dates are fixed around **11 October 2026**, so a fresh seed shows bills and tasks as overdue relative to that day. Change `day()` in `seed/lib.mjs` to move it. New record ids also mean updating the bill ids in `shots/shots.js`.

## Rules for wiki pictures

Dark theme (the app's default), the demo household only, and never real names, bills or addresses. See "Improving this wiki" on the wiki's Contributing page.
