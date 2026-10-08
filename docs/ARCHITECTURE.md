# Architecture

This document explains the design decisions behind the platform.

## Goals

1. **Production-quality foundation, not a prototype.** Clean separation of
   concerns, strict typing, reusable services.
2. **Event-driven and extensible.** The website is the source of truth; Home
   Assistant / NFC will feed it events later without tight coupling.
3. **Self-hostable** with Docker on MongoDB (see [`docker.example/`](../docker.example)).

## Layering

```
Request
  -> Route handler (src/app/api/**)         thin; no business logic
  -> withAuth wrapper (src/server/api/http) auth, household scoping, Zod, rate limit, audit hook
  -> Service (src/server/services/**)       all business rules; only layer touching Prisma
  -> Prisma (src/server/db/prisma.ts)       single client instance
```

**Rule:** business logic never lives in a route handler. Handlers parse + delegate.
Services own the rules and are the only code that touches the database. Every
state-changing service writes an `ActivityEntry`, so the activity feed is an
authoritative, append-only log of household events.

UI follows the same separation: Server Components fetch via services for the
initial render; interactive mutations go through the typed API (`/api/*`) with
TanStack Query for cache + optimistic-ish updates.

## Database (MongoDB via Prisma)

The app runs on **MongoDB** through Prisma's MongoDB connector (the `mongo`
service in [`docker.example/docker-compose.yml`](../docker.example/docker-compose.yml)).

- `prisma/schema/models.prisma` — single source of truth for all models. Each id
  is `String @id @default(cuid()) @map("_id")` (cuid stored as the Mongo `_id`);
  relation scalar fields stay plain `String`.
- `prisma/schema/datasource.prisma` — static `mongodb` datasource
  (`url = env("DATABASE_URL")`).
- No SQL migrations on Mongo: schema changes are applied with `npm run db:push`
  (`prisma db push`).

The schema sticks to portable, document-friendly types:

| Avoided | Used instead |
| --- | --- |
| Prisma `enum` | `String` column + Zod enum (`src/lib/enums.ts`) |
| `Json` column | `String` of JSON text, parsed with Zod |
| Scalar lists (`String[]`) | Relations or delimited strings (e.g. `byWeekday="1,3,5"`) |

**Transactions need a replica set.** Several services use
`prisma.$transaction(...)` (task complete, bill pay, calendar/shopping/user
mutations), which Prisma can only run against a Mongo **replica set**. The
compose `mongo` service runs a single-node replica set (`rs0`); a plain standalone
`mongod` would break those write paths.

## Recurrence engine

`src/server/services/recurrenceService.ts` is **pure** (no IO) so it is directly
unit-tested (`recurrenceService.test.ts`). `computeNextRunAt(rule, from)` returns
the next occurrence strictly after `from`, aligned to the rule's anchor and to
`byWeekday` / `byMonthday` where given, computed in UTC. Supported kinds: daily,
weekly, monthly, interval. `cron` is reserved for an external scheduler and
returns `null` for now.

On completing a recurring task, `taskService.completeTask` records a
`TaskCompletion`, advances `RecurrenceRule.nextRunAt` and the task's `dueDate`,
and resets status to `pending` — all in one transaction.

## Authentication

Better Auth with the Prisma adapter (provider matched to the active datasource),
email/password, HTTP-only signed cookies, 7-day sessions with a short cookie
cache. `role` (`head` > `manager` > `member` > `guest`) and `householdId` are
application-managed fields assigned by first-run setup or the admin. Cookies
carry no Secure flag so sign-in works over plain HTTP on the home network; the
auth route adds it on HTTPS responses, and a home-network origin is trusted only
for same-origin requests (`src/server/security/network.ts`). Guarding is two-tier:

- **`src/proxy.ts`** (Next 16's renamed middleware) — optimistic cookie check to
  redirect unauthenticated page requests to `/login`. It does **not** guard
  `/api`, which authenticates itself and returns JSON `401`s.
- **`requireUser()`** (`src/server/auth/session.ts`) — authoritative check in
  Server Components, also enforcing household membership.

## Data model

All models have services and UI: `Household`, `User`/`Session`/`Account`/
`Verification` (Better Auth), `Category`, `Task`/`Subtask`, `RecurrenceRule`,
`TaskCompletion`, `ActivityEntry`, `ShoppingList`/`ShoppingItem`, `Purchase`
(written when a shopping item is marked purchased), `InventoryItem`, `Bill`/
`BillPayment`, `CalendarEvent`, `Notification`, `EventLog`, `NfcTag`,
`HomeAssistantIntegration`, `ContactMessage`.

## Feature systems

- **Bills.** `billService` owns bills, payments (partial payments, card fees),
  and recurrence; `billIngestService` turns a parsed bill document into
  bills/payments, matching by reference, account number, then biller
  (`billerKey` / `billerEmail`) + amount within a card-fee band.
  - *Paperless import* (`paperlessSync`, `server/paperless/`): each reminder
    sweep (and Settings → *Check now*) lists Paperless documents tagged
    `bill` / `bill-payment` modified since `PaperlessSync.cursor` and older
    than a 10-minute settle window, maps custom fields (Amount, Due date,
    Account number, Invoice number) to the ingest input
    (`mapping.ts`, pure + tested), and ingests with `source: "paperless"` and
    `createUnmatchedReceipts: false` (an unmatched payment is reported, not
    made into a paid bill). Dedup key `paperless:<doc id>`; bills re-import in
    place, payments once. The first run only records the start time, so
    existing documents are never bulk-imported. Read-only, API v9, token auth;
    off until `PAPERLESS_URL` + `PAPERLESS_TOKEN` are set. Status + recently
    skipped documents are on the Settings card. Dry run:
    `npm run paperless:preview`. One-time setup with an admin login
    (`npm run paperless:setup`, `server/paperless/setup.ts`, run by the deploy
    walkthrough inside the web container): tags, fields, read-only user +
    token, starter workflows/views, biller correspondents, optional content
    matching and bill mailbox (mail account + rules); idempotent by name, and
    the only code that writes to Paperless. Shared tag/field names:
    `server/paperless/names.ts`. Runbook: `docs/paperless-import.md`.
  - *Android app download* (`appDownloadService`, `GET /api/app/download`,
    Profile card): serves the APK the deploy builds
    (`docker.example/android/Dockerfile`) from `APP_DOWNLOAD_DIR` (android/out,
    mounted read-only), described by its `ourhome.json`; signed-in members only,
    nothing shown when no build exists. `GET /api/app/info` gives the app its
    "update available" check. `appReleaseService.announceAppRelease` (every
    reminder sweep; the deploy triggers one after a build) posts one
    household-wide `system` notification per version (dedupeKey
    `app_release:<versionCode>`, older ones removed, links to /profile) and an
    `app_update` push to every registered phone.
  - Paperless, the Proton Bridge it reads mail through, and MongoDB are
    separate stacks in
    [OurHomeServices](https://github.com/EOSOClub/OurHomeServices).
- **Event ingestion / Home Assistant / NFC.** Two scan paths share
  `eventService.ingestNfcScan` (EventLog `nfc_scan` / `nfc_register`):
  - *Android app (preferred):* reads the tag itself (HA tag id from the NDEF URL,
    else `uid:<hex>`) → `GET /api/nfc/lookup` → `POST /api/nfc/scans` (session,
    `inventory:write`, source `nfc`, credited to the user). Unknown tags are set
    up in-app via `POST /api/nfc/setup` (bind to an item or create it).
    `GET /api/nfc/scans` is the scan history. The app writes tags as
    `ourhome://tag/<id>` (same id). Per-tag app settings live in
    `NfcTag.config` (`scanAction` open/notify, `shoppingListId`) —
    `POST /api/nfc/tags/settings`; a "notify" tag's notification can
    `POST /api/nfc/shopping` (add the item to its list, no duplicates).
  - *Legacy:* `NFC → Home Assistant → /api/webhooks/nfc (token auth)`, which
    auto-registers unknown tags by HA friendly name.
  - HA as a display: `GET /api/integrations/inventory` (same token) is a
    read-only feed; config in `HomeAssistant/display.yaml`.
  Tokens and the web tag mappings live on the Settings page; runbooks in `docs/`.
- **Notifications & reminders.** `reminderService` generates overdue-task,
  low-inventory, predicted-depletion, and bill-due notifications. The
  production server sweeps every household every 15 minutes in-process
  (`src/instrumentation.ts` → `reminderSweep`). The same sweep can be triggered
  via `/api/cron/reminders` (guarded by `CRON_SECRET`), and it also runs
  opportunistically when the notifications page is opened. Only the `in_app` channel is dispatched today; Home
  Assistant / Discord channels are reserved seams. (Generated reminders are
  also emailed when created; phone push currently covers requests and bug
  reports only, see *Instant push*.)
- **Shopping & grocery.** `shoppingService` owns lists (create, rename, delete)
  and items (add, check-off, edit, delete, and a "clear bought" that deletes
  one-off items but un-checks recurring consumables). Marking an item purchased
  records a `Purchase` for history. `/shopping` is a mobile-first list view.
- **Inventory.** `inventoryService` owns items, quantity adjustments (manual or
  NFC-driven), low-stock thresholds, and a restock forecast
  (`predictedDepletionAt`, derived from `reorderIntervalDays` and the last
  restock) that feeds reorder reminders.
- **Requests.** `requestService` owns household requests. Everyone sees all
  requests on `/requests`, grouped by category; only the requester can edit or
  delete their own.
  - *Media* — movies and TV shows (`mediaType`, name, year, optional TV season).
    Lifecycle `pending` → `accepted` → `completed` ("available"), driven by
    whoever holds `requests:manage_media` (the head). Rows created before media
    had a status have none — treat a missing status as `pending`.
  - *Maintenance* — the requester asks another member (`assigneeId`, never
    themself). Lifecycle `pending` → `accepted` → `completed`: the assignee
    accepts with a done-by date stored as `dueAt` (the deadline), may move it,
    and marks it done; reassigning resets to `pending`.
  - **Phone reminders (Android app):** a WorkManager job polls `/api/requests`
    hourly and notifies the signed-in user while anything awaits *their*
    acceptance (pending media for the head; pending maintenance assigned to
    them). The same poll sends maintenance deadline reminders from `dueAt`:
    the assignee is told the day before, on the day, and daily while overdue;
    the requester once when it goes overdue. Every request change also sends
    an instant push (see *Instant push* below), so the hourly poll is now the
    fallback. No in-app (bell) equivalent — `reminderService` would be the
    place for one.
  - `/api/household/members` gives any member an id+name list for the
    assignee picker (the full `/api/members` stays behind `members:manage`).
- **Bug reports.** "Report a bug" in the web header and the app's ⋮ menu →
  `POST /api/bug-reports` → `bugReportService`: stores a `BugReport`, adds a
  `bug_report` notification addressed to each `bugs:manage` holder (the head),
  then emails `BUG_REPORT_EMAIL` (unset = no email) via the SMTP
  mailer. Email outcome is recorded in `BugReport.emailStatus`
  (`emailed` / `email_failed` / `not_configured`) and logged; it never fails
  the submit. The Android app alerts the head once per new report (instant
  push, with the hourly poll as fallback).
  Notifications with a `userId` are visible only to that user; rows without one
  are household-wide (`notificationService.visibleTo`).
- **Instant push (Android app).** Firebase Cloud Messaging, off until
  `FIREBASE_SERVICE_ACCOUNT` is set (in `.env`; setup in
  `docs/push-notifications.md`). The app registers its FCM
  token after sign-in (`POST /api/push/devices`, stored as `PushDevice`) and
  removes it on sign-out (`POST /api/push/devices/delete`).
  `pushService.pushSync` sends a **content-free**, data-only message
  (`{ type: "sync", reason }`) that makes the phone run its normal check right
  away, so request text, names and amounts never pass through Google and the
  app's lock-screen rules cover every alert. Fire-and-forget: a failed push
  never fails the action; the phone catches up hourly. Sent on every request
  create/update/accept/complete/delete (to the requester, the handler, and
  for a reassignment the previous assignee) and on each new bug report (to
  `bugs:manage` holders). `server/push/fcm.ts` calls the FCM HTTP v1 API
  directly (signed JWT → OAuth token) rather than `firebase-admin`, which needs
  Node 22+. Tokens FCM reports as dead are deleted.
- **Permissions.** Role-based (`head`/`manager`/`member`/`guest`) via
  `src/lib/permissions.ts`; routes enforce `requirePermission`, and the guest
  task-completion scope (own assignments only) is enforced in
  `taskService.completeTask`. Creating/editing/deleting tasks is head-only.
  The full matrix, changelog and planned follow-ups are in
  [`docs/permissions.md`](./permissions.md).

## Tradeoffs / notes

- **Prisma 6, not 7.** Prisma 7 moves the DB URL into config and changes the
  engine packaging; Prisma 6's embedded engine keeps the MongoDB setup simple and
  reliable.
- **Rate limiter is in-memory** (single instance). Swap for Redis/Upstash when
  running multiple instances behind a load balancer.
- **No public sign-up flow.** On an empty database `/setup` creates the
  household and its Head of House (home-network requests only, and only while no
  account exists); after that, accounts are added by the admin from Members.
```
