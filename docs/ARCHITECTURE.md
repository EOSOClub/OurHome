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
authoritative, append-only log of household events. It is read on its own
page (`/activity`, `GET /api/activity`, filtered by area — `lib/activityAreas.ts`
— and person), not on the dashboard: the dashboard (`dashboardService`) is
"my day first" — the viewer's tasks due today, requests waiting on them
(`lib/requestAttention.ts`, mirrored by the app's `RequestAttention.kt`),
their points this week, then a household glance.

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
`byWeekday` / `byMonthday` where given. It works on local "wall clock" dates in
`rule.timeZone` (callers pass the household's zone from `getPointsSettings`),
so a noon due date stays noon across DST and weekdays are local weekdays.
Weekday / month-day rules never occur before the anchor and honour `interval`
(every other Tuesday, every second month). Supported kinds: daily, weekly,
monthly, interval. `cron` is reserved for an external scheduler and returns
`null` for now.

Completing a recurring task or paying a recurring bill moves on with
`nextAfterOccurrence(rule, dueDate)`: counted from the current due date while
that is still ahead (picked dates sit at 12:00, so counting from "now" in the
morning landed on the same occurrence and a task could be completed — and
paid — again). `taskService.completeTask` records a `TaskCompletion`, advances
`RecurrenceRule.nextRunAt` and the task's `dueDate`, and resets status to
`pending` — all in one transaction.

**Due vs overdue.** A due date picked without a time is stored at 12:00 local
and is due all day: it counts as overdue from the next day (`lib/format.ts`
`isOverdue`, household zone on the server). A task with an explicit due time
is overdue once that time passes. Pages, the dashboard counts and the reminder
sweep all use this one rule.

## Authentication

Better Auth with the Prisma adapter (provider matched to the active datasource),
email/password, HTTP-only signed cookies, 7-day sessions with a short cookie
cache. Server code reads the session with `disableCookieCache` (`server/auth/session.ts`),
so a role change or removal applies on the next request, not after the cache's
5 minutes. The forced password change is lifted by an `after` hook on
`/change-password`, never by the client. `role` (`head` > `manager` > `member` > `teen` > `child` > `guest`) and `householdId` are
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

- **Households and the server admin.** One server can hold several
  households. Every household row carries `householdId`, every route gets the
  household from the session (never the request — `src/server/api/routes.test.ts`
  checks), and one person belongs to one household. Usernames and emails are
  unique across the server, so sign-in has no household picker.
  `User.isServerAdmin` (`serverAdminService`) owns the server: the **Server**
  page (`/server`) lists households, creates one with its Head of House
  (temporary password, forced change), resets a head's password, and turns a
  household off (`Household.disabledAt`: members signed out, pages redirect to
  `/no-household?disabled=1`, the API answers 403, token webhooks and the
  reminder sweep skip it; nothing deleted). It also holds the server-wide
  settings: **HTTPS only** (`ServerSettings.allowHttp`; until first saved, the
  old per-household value applies) and contact-form messages. The server admin
  sees no other household's data. First-run setup makes the first account the
  server admin; on older installs the oldest household's head becomes it on
  first use.
- **Household export and delete** (`householdDataService`). The Head of
  House downloads everything the household stores as one JSON file (Settings →
  Export; `GET /api/household/export`), without credentials (passwords,
  sessions, Home Assistant/Paperless/push tokens) or the request log. The
  server admin deletes a household for good (Server page; only when turned
  off, never their own, exact name typed): an explicit, ordered delete of every
  model in one transaction — not cascades, since several models link by a
  plain id. `HOUSEHOLD_MODELS` / `SERVER_MODELS` list every schema model, and a
  test fails when a new model isn't covered. **Restore** (`householdRestore`,
  Server page → Restore from export) loads an export as a *new* household:
  every record gets a fresh id and every reference is rewired, including ids
  inside text (rotation lists, undo snapshots, notification keys) — a pure,
  unit-tested `planRestore` — and only fields the current schema knows are
  written (Prisma DMMF), so older/newer exports load. Refused when a member's
  username or email is taken on the server. The head gets the admin's
  temporary password; other members get theirs from the head. Home Assistant
  and Paperless must be reconnected (their tokens aren't exported). One
  transaction.
- **Paperless per household** (`paperlessSync`, `PaperlessConnection`). Each
  household connects its own Paperless (Head of House, Settings); the token is
  encrypted (`security/secrets.ts`, AES-GCM, key from `BETTER_AUTH_SECRET`).
  The settings.yml/.env connection is a fallback for `PAPERLESS_HOUSEHOLD_ID`
  or the server admin's household. Each household has its own cursor/status
  (`PaperlessSync`) and runs separately in the sweep. Outbound calls for a
  household not trusted with the server's private network
  (`Household.paperlessPrivateNetwork`, server admin's household always) pass
  the link-preview SSRF guard (`isPublicFetchTarget`) and never follow
  redirects. Runbook: `docs/paperless-import.md`.

- **Rotating assignees.** `Task.rotationUserIds` holds member ids in turn
  order (comma-separated; fewer than two = no rotation). Pure rules in
  `lib/taskRotation.ts` (+ test); `taskService` applies them: completing a
  recurring task without cycles passes it to the next person; with cycles,
  each cycle that ends (done *or* missed) is one turn, applied in
  `rollTaskCycles`. Undo restores the assignee (`CompletionSnapshot.assigneeId`).
  Saving a rotation puts the assignee on it ("whose turn now"); a hand-picked
  assignee without a rotation in the request (older app) is kept as a stand-in,
  and the next turn then goes to the first person. Members who leave drop out.
  The DTO carries `rotation` + `nextAssignee`. Edited in the task form's
  "Take turns" (recurring tasks only), on web and app.
- **"Your turn" notices** (`taskReadyService`, type `task_ready`). When a task
  becomes someone's to do — created or reassigned to them, passed on by a
  rotation, a new cycle opening, or (without cycles) the next occurrence after
  someone else completed it — its assignee gets one bell row addressed to them
  plus a phone push (`reason: "task"`; the app alerts through the household
  reminder notification). One per task: newer replaces older; completing,
  archiving or deleting removes it. Whoever caused it isn't notified. Not
  emailed.
- **The bell** is a to-do list: the page shows unread by default, and opening a
  notification marks it read and goes to its subject (`/tasks?task=<id>` opens
  and highlights that task; bills, stock, requests, calendar, settings). The
  app does the same (unread only; a tap opens the tab).
- **Profiles.** `User.bio/avatarEmoji/profileColor/birthday` — the
  user's own "About me" (`PATCH /api/profile`; blank clears; one emoji;
  colour keys and `MM-DD` birthdays in `lib/profile.ts`, mirrored in the app's
  `data/ProfileStyle.kt`). Every member can read everyone's via
  `GET /api/household/members` (also the picker list; now with role) — shown
  as the Household card on Profile. Emails stay behind `members:manage`.
  Changing your own email needs your current password (`currentPassword`):
  password resets go there.
- **Household references.** Ids pointing at other rows (task assignee,
  task/shopping/inventory category) are checked to belong to the household
  (`householdRefs.ts`); Mongo has no foreign keys.
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
- **Task points.** Tasks carry a time to complete and points (split over their
  steps by `src/lib/taskPoints.ts`, shared with the editor). Checking a step
  queues its points (`PendingCredit`); completing pays everything into the
  `PointAward` ledger; recurring tasks can run in cycles that roll over at
  local midnight (`src/lib/taskCycles.ts`, missed cycles recorded). Stats at
  `/points`. `pointsService` + `taskService`; full rules in `docs/points.md`.
- **Notifications & reminders.** `reminderService` generates overdue-task,
  low-inventory, predicted-depletion, and bill-due notifications. The
  production server sweeps every household every 15 minutes in-process
  (`src/instrumentation.ts` → `reminderSweep`). The same sweep can be triggered
  via `/api/cron/reminders` (guarded by `CRON_SECRET`), and it also runs
  opportunistically when the notifications page is opened. Only the `in_app` channel is dispatched today; Home
  Assistant / Discord channels are reserved seams. Each reminder carries its
  audience (`audienceUserIds`): the people tied to the subject plus the page's
  grid managers (`withManagers`; table in `docs/permissions.md`). Only they see
  it in the bell, get its email when created, and get the push.
- **Shopping & grocery.** `shoppingService` owns lists (create, rename, delete)
  and items (add, check-off, edit, delete, and a "clear bought" that deletes
  one-off items but un-checks recurring consumables). Marking an item purchased
  records a `Purchase` for history. `/shopping` is a mobile-first list view.
  Lists and items are separate rows in the page-access grid ("Shopping lists"
  / "Shopping items"); the Android app can create, rename and delete lists too.
- **Inventory.** `inventoryService` owns items, quantity adjustments (manual or
  NFC-driven), low-stock thresholds, and a restock forecast
  (`predictedDepletionAt`, derived from `reorderIntervalDays` and the last
  restock) that feeds reorder reminders.
- **Requests.** `requestService` owns household requests. Everyone sees all
  requests on `/requests`, grouped by category; only the requester can edit or
  delete their own.
  - *Media* — movies and TV shows (`mediaType`, name, year, optional TV season).
    One step: `pending` ("waiting") → `completed` ("added"), by anyone with the
    Requests **Approve** switch (head + managers by default). Rows created
    before media had a status have none — treat a missing status as `pending`;
    `accepted` rows from the older accept → available flow also still wait.
  - *Maintenance* — the requester asks another member (`assigneeId`, never
    themself). Lifecycle `pending` → `accepted` → `completed`: the assignee
    accepts with a done-by date stored as `dueAt` (the deadline), may move it,
    and marks it done; reassigning resets to `pending`.
  - **Phone reminders (Android app):** a WorkManager job polls `/api/requests`
    hourly and notifies the signed-in user while anything awaits *their*
    acceptance (open media for media approvers; pending maintenance assigned to
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
  Notifications with a `userId` are visible only to that user; generated
  reminders only to their audience; other rows without one are household-wide
  (`notificationService.visibleTo`). Read state is per person
  (`readByUserIds`); the old shared `readAt` is only read, for rows marked read
  before the switch.
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
  for a reassignment the previous assignee), on each new bug report (to
  `bugs:manage` holders), and when reminder generation creates a new reminder
  (to its audience, `Notification.audienceUserIds`). `server/push/fcm.ts` calls the FCM HTTP v1 API
  directly (signed JWT → OAuth token) rather than `firebase-admin`, which needs
  Node 22+. Tokens FCM reports as dead are deleted.
- **Permissions.** Role-based (`head`/`manager`/`member`/`teen`/`child`/`guest`)
  via `src/lib/permissions.ts`; routes enforce `requirePermission`, and the guest
  task-completion scope (own assignments only) is enforced in
  `taskService.completeTask`. Add/edit/delete per page (and approving media
  requests) is the head-editable page-access grid; tasks are head-only by default.
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
