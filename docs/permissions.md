# Permissions

Role-based access lives in [`src/lib/permissions.ts`](../src/lib/permissions.ts)
(the matrix) and is enforced server-side by `requirePermission` in each route
handler. The web UI and the Android app only *hide* controls a role can't use;
the server is the authority.

## Current matrix

| Permission | head | manager | member | guest |
| --- | :-: | :-: | :-: | :-: |
| `household:manage` (rename household, transfer headship) | ✓ | | | |
| `members:manage` | ✓ | ✓¹ | | |
| `settings:manage` (HA tokens, NFC tags, categories) | ✓ | ✓ | | |
| `tasks:write` (create / edit / delete tasks + checklists) | ✓ | | | |
| `tasks:complete` (complete tasks, tick checklist items) | ✓ | ✓ | ✓ | ✓² |
| `shopping:write`, `inventory:write`, `bills:write`, `calendar:write` | ✓ | ✓ | ✓ | |
| `requests:write` (make requests; edit/delete **own** only³) | ✓ | ✓ | ✓ | ✓ |
| `requests:manage_media` (accept movie/TV requests, mark available; gets the app's media reminders) | ✓ | | | |
| `bugs:report` (file a bug report) | ✓ | ✓ | ✓ | ✓ |
| `bugs:manage` (receive bug reports: bell + phone alert) | ✓ | | | |

¹ Managers may only manage members/guests (`canManageMember`).
² Guests only on tasks assigned to them (enforced in `taskService`).
³ Ownership is enforced in `requestService` — nobody, including the head, can
  edit or delete another person's request. For maintenance requests, only the
  **assignee** can accept (set the done-by date) and mark done.

## Changelog

- **2026-10-05** — `tasks:write` made **head-only**. Previously manager and
  member could also create/edit/delete tasks. Everyone keeps `tasks:complete`.
- **2026-10-05** — Added `requests:write` (all roles) for the new Requests
  page (movies / TV). Requests are edit/delete-by-owner only.
- **2026-10-05** — Added `requests:manage_media` (head) — media requests now
  have a status and the head accepts them / marks them available.

## Follow-ups (planned — not done yet)

Permissions are going to be expanded. Open questions to settle then:

- [ ] Should managers regain `tasks:write`, or get a narrower "edit tasks
      assigned to me" scope?
- [ ] Head-only edit/delete for the other modules (shopping, inventory, bills,
      calendar)? Today any member can edit or delete there.
- [ ] Split create vs. edit vs. delete into separate permissions (e.g. members
      may add shopping items but not delete bills).
- [ ] Per-record ownership (creator/assignee may edit their own records).
- [ ] Guest scope beyond completing assigned tasks (e.g. shopping check-off).
- [ ] Requests: should the head be able to edit/remove anyone's request (e.g.
      to clean up duplicates or mark fulfilled)? Today only the requester can.
- [ ] Keep the Android app's mirror of this matrix
      (OurHomeApp repo: `app/src/main/java/com/eosoclub/ourhome/data/Permissions.kt`)
      in sync — or expose permissions from the API (e.g. in `get-session`) so
      clients don't duplicate the matrix.
