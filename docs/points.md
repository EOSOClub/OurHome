# Task points

Tasks carry a time to complete (TTC) and points. People earn points by doing
the work; the stats show day / week / month / year totals and points per day
per person. The rules live in pure, tested modules:

| What | Where |
| --- | --- |
| Time/points maths for the editor and the server | `src/lib/taskPoints.ts` (mirrored in the app's `data/TaskPoints.kt`) |
| Cycle boundaries and stats periods (household time zone) | `src/lib/taskCycles.ts` |
| Payout, undo rights, ledger, stats | `src/server/services/pointsService.ts` |
| Wiring into tasks (check, complete, roll over, undo) | `src/server/services/taskService.ts` |

## Settings (head)

`/api/points/settings`: `minutesPerPoint` (default 10, so 1 point per 10
minutes), `timezone` (default America/Chicago), `weekStartsOn` (default 0 =
Sunday). Changing the rate doesn't touch existing tasks; their values are stored.

## Time and points

- A task has a base TTC and base points, set only by task-level edits. Its
  rate is base points ÷ base minutes (the household rate without time).
- **Points follow time** (saved per task and per step, on by default): a TTC
  change recalculates points. Typing points by hand turns it off. Changing
  points never changes time.
- A task with steps shows live totals, the sum of its steps.
- Editing a step's TTC marks it customised and recalculates its points at the
  task's rate (unless its points are hand-set). Editing a step's points marks
  them customised. Neither touches other steps or the task base, so nothing
  recalculates in a circle.
- Editing a task total redistributes that dimension (both, when points follow
  time) across the steps in proportion to their current values. If any step is
  customised the editor warns first; confirming rescales everything and clears
  the customisation; cancelling changes nothing.
- Adding/removing a step re-splits the base while no step is customised; once
  one is, totals float (a new step gets the average values).
- Points are stored as integer hundredths; splits use largest-remainder
  rounding, so parts always add up exactly (10 over 3 steps = 3.33 / 3.33 / 3.34).
- Tasks from before points: base TTC = their old estimate, points follow time,
  steps split evenly. Written to the database on their next change or completion.

## Earning

- A step's **first check** in a cycle queues its points for whoever checked it
  (`PendingCredit`). Nothing is paid until the task is completed.
- **Completing** pays every step exactly once: queued steps to whoever checked
  them, the rest to the completer (who also checks them). A task without
  steps pays its points to the completer. Awards add up to the task's points.
- A step with its own reset ("unchecks every N days") keeps its queued points
  through the reset; **re-checking it after the reset pays that step at once**
  (`step_repeat`), on its own. Same for a reset step on a finished task.
- **Unchecking by hand** drops that step's queued points. Unchecking and
  re-checking by hand never earns twice.
- Undo: the completer may undo a completion within 10 minutes; the head any
  time. It restores the task as it was and voids the points, but only for the
  task's latest completion with nothing done on the task since. Otherwise the
  head voids individual entries in the ledger, with a reason. Unchecking a step
  that paid at once voids that payment within the same 10 minutes.
- The ledger (`PointAward`) is never edited except to void, and keeps task and
  step titles, so history survives deleting a task.

## Cycles (recurring tasks, optional)

`RecurrenceRule.rollover` with `cycleWeekdays` (weekly) or `cycleMonthdays`
(monthly); daily/interval cycles follow the rule. Boundaries are local midnight
in the household time zone; a month day past the month's end starts on its
last day (30 and 31 both land on Feb 28/29, once).

- The cycle is the window; the due date sits inside it (overdue reminders as
  usual).
- Completing marks the task **done for this cycle** (status `completed`); it
  reopens at the next cycle start with steps unchecked.
- A cycle that ends unfinished is recorded as **missed** (a `TaskCompletion`
  with outcome `missed`), its queued points are dropped, and the task moves to
  the next window. Rolling over runs in the 15-minute sweep and before any task
  read or change.
- Tasks without cycles behave as before: completing moves them to the next
  occurrence, and a late one simply stays overdue.

## Stats

`GET /api/points/summary?period=day|week|month|year&date=YYYY-MM-DD`: per
member points, points per day (over the days of the period elapsed so far),
award count and queued points; household total and averages per person.
`GET /api/points/awards` is the ledger. `POST /api/points/awards/void` (head).
`POST /api/tasks/completions/undo`.
