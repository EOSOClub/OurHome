# Permissions

Role-based access lives in [`src/lib/permissions.ts`](../src/lib/permissions.ts)
(the matrix) and is enforced server-side by `requirePermission` in each route
handler. The web UI and the Android app only *hide* controls a role can't use;
the server is the authority.

## Role permissions

Fixed per role; not editable in the UI.

| Permission | head | manager | member | guest |
| --- | :-: | :-: | :-: | :-: |
| `household:manage` (rename household, transfer headship, **edit page permissions**) | ✓ | | | |
| `members:manage` | ✓ | ✓¹ | | |
| `settings:manage` (HA tokens, NFC tags, categories) | ✓ | ✓ | | |
| `tasks:complete` (complete tasks, tick checklist items) | ✓ | ✓ | ✓ | ✓² |
| `requests:write` (edit/delete **own** requests³, accept/finish assigned ones; *submitting* is the Requests grid switch) | ✓ | ✓ | ✓ | ✓ |
| `requests:manage_media` (accept movie/TV requests, mark available; gets the app's media reminders) | ✓ | | | |
| `bugs:report` (file a bug report) | ✓ | ✓ | ✓ | ✓ |
| `bugs:manage` (receive bug reports: bell + phone alert) | ✓ | | | |

¹ Managers may only manage members/guests (`canManageMember`).
² Guests only on tasks assigned to them (enforced in `taskService`).
³ Ownership is enforced in `requestService` — nobody, including the head, can
  edit or delete another person's request. For maintenance requests, only the
  **assignee** can accept (set the done-by date) and mark done.

## Page access (editable by the head)

Add / edit / delete on **Tasks, Calendar, Shopping, Inventory and Bills**, and
submitting **Requests**, is a per-page grid the Head of House edits on **Members → Permissions**. Each page
has five switches:

| Switch | Allows |
| --- | --- |
| Add | create records on the page |
| Edit own / Delete own | change / remove records **you created** |
| Edit others' / Delete others' | change / remove records **someone else created**, or that have no creator (imported bills, email calendar events, inventory categories) |

**Resolution** (`resolveAccess` in `src/lib/permissions.ts`):

1. The head always has everything.
2. Otherwise start from the built-in default for the role
   (`BUILTIN_ROLE_ACCESS`): tasks head-only; manager and member get every
   switch on the other pages; guests get nothing; every role may submit
   requests.
3. Apply the household's edits to that role (`Household.roleAccess`).
4. Apply the member's own overrides (`User.accessOverrides`).

Steps 3 and 4 store only the cells that differ from the layer below
(`diffAccess`), so changing a role default still reaches every member who
didn't override that particular switch. Overrides survive a role change.

"Own" is `createdById` on `Task`, `Event`, `ShoppingList`, `ShoppingItem`,
`InventoryItem`, `Bill` and `BillPayment` (for payments: who **recorded** it,
not who paid).

**How each action maps:**

- Requests has only **Add** (= submit a request; `PAGE_ACTIONS`). Editing or
  deleting stays requester-only and accepting stays assignee-only, so someone
  with submitting switched off can still manage what they already asked for.

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
