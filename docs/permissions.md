# Permissions

Role-based access lives in [`src/lib/permissions.ts`](../src/lib/permissions.ts)
(the matrix) and is enforced server-side by `requirePermission` in each route
handler. The web UI and the Android app only *hide* controls a role can't use;
the server is the authority.

## Role permissions

Fixed per role; not editable in the UI.

Roles, highest first: head > manager > member > teen > child > guest. Teen and
child are household members with narrower page-access defaults; a guest is
someone from outside the household.

| Permission | head | manager | member | teen | child | guest |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| `household:manage` (rename household, transfer headship, **edit page permissions**) | ✓ | | | | | |
| `members:manage` | ✓ | ✓¹ | | | | |
| `settings:manage` (HA tokens, NFC tags, categories) | ✓ | ✓ | | | | |
| `tasks:complete` (complete tasks, tick checklist items) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓² |
| `requests:write` (edit/delete **own** requests³, accept/finish assigned ones; *submitting* and *approving media* are Requests grid switches) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `bugs:report` (file a bug report) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `bugs:manage` (receive bug reports: bell + phone alert) | ✓ | | | | | |

¹ Managers may only manage and assign the ranks below them — member, teen,
  child, guest (`canManageMember`, `canAssignRole`).
² Guests only on tasks assigned to them (enforced in `taskService`).
³ Ownership is enforced in `requestService` — nobody, including the head, can
  edit or delete another person's request. For maintenance requests, only the
  **assignee** can accept (set the done-by date) and mark done.

## Page access (editable by the head)

Add / edit / delete on **Tasks, Calendar, Shopping items, Shopping lists,
Inventory and Bills**, and submitting / approving **Requests**, is a per-page
grid the Head of House edits on **Members → Permissions**. Record pages have
five switches; Requests has Add and Approve (`PAGE_ACTIONS`):

| Switch | Allows |
| --- | --- |
| Add | create records on the page |
| Edit own / Delete own | change / remove records **you created** |
| Edit others' / Delete others' | change / remove records **someone else created**, or that have no creator (imported bills, email calendar events, inventory categories) |
| Approve | Requests only: mark media (movie/TV) requests **added**; approvers get the app's media reminders |

**Resolution** (`resolveAccess` in `src/lib/permissions.ts`):

1. The head always has everything.
2. Otherwise start from the built-in default for the role
   (`BUILTIN_ROLE_ACCESS`):

   | Page | manager | member | teen | child | guest |
   | --- | :-: | :-: | :-: | :-: | :-: |
   | Tasks | — | — | — | — | — |
   | Calendar | all | all | own | — | — |
   | Shopping items | all | all | own | add | — |
   | Shopping lists | all | all | — | — | — |
   | Inventory | all | all | own | — | — |
   | Bills | all | all | — | — | — |
   | Requests | add + approve | add | add | add | add |

   "own" = Add + Edit own + Delete own; "add" = Add only.
3. Apply the household's edits to that role (`Household.roleAccess`).
4. Apply the member's own overrides (`User.accessOverrides`).

Steps 3 and 4 store only the cells that differ from the layer below
(`diffAccess`), so changing a role default still reaches every member who
didn't override that particular switch. Overrides survive a role change.

"Own" is `createdById` on `Task`, `Event`, `ShoppingList`, `ShoppingItem`,
`InventoryItem`, `Bill` and `BillPayment` (for payments: who **recorded** it,
not who paid).

**How each action maps:**

- Requests has **Add** (= submit a request) and **Approve** (= mark media
  requests added, one step: waiting → added). Editing or deleting stays
  requester-only and accepting maintenance stays assignee-only, so someone
  with submitting switched off can still manage what they already asked for.
- **Shopping lists** guards creating, renaming and deleting lists;
  **Shopping items** guards the items on them.

- Checklist items (add, rename, reorder, remove) edit their task. Ticking one
  off is `tasks:complete`.
- Recording a bill payment and duplicating a bill need Bills **Add**.
- Ticking a shopping item bought, adjusting stock (+/−), NFC scans and NFC
  tag binding need **any** switch on that page. Creating an item during NFC
  setup needs Inventory **Add**; "add to shopping list" needs Shopping **Add**.
- "Clear bought" removes only the bought items you may delete; recurring
  items are just un-checked.
- Deleting a shopping list deletes all its items, whoever added them.

**Enforcement:** route handlers call `requireCreate`, `requireModify` (with the
owner from `recordOwner.*`) or `requireAnyAccess` from `src/server/api/http.ts`.
The grid is read from the database on each request, not from the session
cookie, so changes apply immediately. Pages pass `access` + `userId` to the
views, which only hide controls.

**API:** `GET /api/permissions/me` returns the caller's grid (for the Android
app). The head's editor uses `GET /api/permissions`,
`POST /api/permissions/role` and `POST /api/permissions/member`
(`access: null` resets a member to the role default).

## Changelog

- **2026-10-08** — New roles **teen** and **child** (between member and
  guest) with tiered defaults (table above).
- **2026-10-08** — Replaced `requests:manage_media` with the Requests
  **Approve** switch (head + managers by default). Media is now one step:
  "Mark as added" completes it (old "accepted" rows still count as waiting;
  `/api/requests/accept` on media marks it added, for older app builds).
- **2026-10-08** — **Shopping lists** row split from Shopping (now "Shopping
  items"); list create/rename/delete use it. Defaults match the old behaviour
  for managers and members. Stored Shopping overrides don't carry over to it.

- **2026-10-07** — Replaced `tasks:write`, `shopping:write`, `inventory:write`,
  `calendar:write` and `bills:write` with the editable page-access grid above
  (role defaults + per-member overrides, own vs others'). Defaults match the
  previous behaviour.
- **2026-10-07** — Requests row in the grid: the head can switch off
  submitting requests per role or member (on for everyone by default).

- **2026-10-05** — `tasks:write` made **head-only**. Previously manager and
  member could also create/edit/delete tasks. Everyone keeps `tasks:complete`.
- **2026-10-05** — Added `requests:write` (all roles) for the new Requests
  page (movies / TV). Requests are edit/delete-by-owner only.
- **2026-10-05** — Added `requests:manage_media` (head) — media requests now
  have a status and the head accepts them / marks them available.

## Follow-ups (planned — not done yet)

- [ ] Requests: should the head be able to edit/remove anyone's request (e.g.
      to clean up duplicates or mark fulfilled)? Today only the requester can.
- [ ] Keep the Android app's `defaultAccess` (OurHomeApp repo,
      `data/Permissions.kt`) in sync with `BUILTIN_ROLE_ACCESS` — it's what the
      app shows before `/api/permissions/me` loads. The app reads the real grid
      from that endpoint and uses `createdById` for own vs others'.
