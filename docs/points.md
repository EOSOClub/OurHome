# Task points

Tasks carry a time to complete (TTC) and points. People earn points by doing
the work; the stats show day / week / month / year totals and points per day
per person. The rules live in pure, tested modules:

| What                                                     | Where                                                                |
|----------------------------------------------------------|----------------------------------------------------------------------|
| Time/points maths for the editor and the server          | `src/lib/taskPoints.ts` (mirrored in the app's `data/TaskPoints.kt`) |
| Cycle boundaries and stats periods (household time zone) | `src/lib/taskCycles.ts`                                              |
| Payout, undo rights, ledger, stats                       | `src/server/services/pointsService.ts`                               |
| Wiring into tasks (check, complete, roll over, undo)     | `src/server/services/taskService.ts`                                 |

## Settings (head)

`/api/points/settings`: `minutesPerPoint` (default 10, so 1 point per 10
minutes), `timezone` (default America/Chicago), `weekStartsOn` (default 0 =
Sunday). Changing the rate doesn't touch existing tasks; their values are stored.

## Time and points

- A task has a base TTC and base points, set only by task-level edits. Its
  rate is base points ÷ base minutes (the household rate without time).
- **Points follow time** (saved per task and per step, on by default): a TTC
  change recalculates points. Typing points by hand turns it off. Changing
  points never changes time. A step whose points follow time is always worth
  its own minutes at the task's rate; turning the task's switch back on gives
  every step that, and only asks first if a step's points were set by hand.
- A task with steps shows live totals, the sum of its steps.
- **Steps share the task's time** (`Task.stepsShareTime`, on for new tasks):
  while the task has a time, that time is held. The steps not set by hand
  split what the hand-set ones leave. Editing a step's TTC marks it customized
  and takes the difference from the other steps, or gives it back, in
  proportion to their time: the ones not set by hand first, all of them when
  every other one was. A step can't take more than the task's time minus what
  the hand-set steps that don't move keep. Adding or removing a step re-splits
  the same way. A lone step set below the task's time leaves the rest
  unassigned (the editor says so) until another step takes it. Minutes stay
  whole, so 25 over two steps is 12 + 13. A task with no time has nothing to
  hold, so its steps add up.
- **Off** (the old behaviour): editing a step's TTC changes only that step,
  recalculating its points at the task's rate unless they're hand-set. The
  task base is left alone, so the live totals float. Adding/removing a step
  re-splits the base while no step is customized; once one is, a new step gets
  the average time, with its points following that time.
- Editing a step's points marks them customized and changes only that step, in
  both modes.
- Tasks saved before the switch existed (`stepsShareTime` null) count as on
  when their steps add up to their time and off when they had drifted, so no
  stored number moves. An older app that saves a checklist without the field
  keeps it on only while the steps it sends still add up. Turning the switch on
  holds what the task shows: drifted steps make their sum the task's time.
- Editing a task total redistributes that dimension (both, when points follow
  time) across the steps in proportion to their time. If that would overwrite
  a hand-set value in the dimension being changed, the editor warns first;
  confirming rescales everything and clears that customization; cancelling
  changes nothing.
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
  re-checking by hand never earns twice. Unchecking a step that paid at once
  (within the undo window, so its payment is voided) puts it back to "after
  its reset": checking it again pays once more.
- Steps can't be ticked on an archived task.
- **Completed stays completed**: an edit can't set a task to completed (use
  Complete, which pays) or reopen a completed one (use Undo, which takes the
  points back). Switching cycles off on a task done for this cycle moves it on
  to its next occurrence.
- Undo: the completer may undo a completion within 10 minutes; the head any
  time. It restores the task as it was and voids the points, but only for the
  task's latest completion with nothing done on the task since. Otherwise, the
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
- Tasks without cycles: completing moves them to the next occurrence and
  locks them until it opens (`Task.opensAt`, recurrenceService
  `completeOccurrence`): local midnight after the due date or now, whichever
  is later. The next due date is the first occurrence from then, so done early it's
  the one after the due date, and done late it skips the rest of today. One
  completion pays once; before this lock it could be completed again at once,
  skipping ahead and paying each time. A late one simply stays overdue. Undo
  restores the lock as it was; removing the repeat clears it.
- Restoring an archived task that was done brings it back done (a cycle task
  whose fresh window starts after it was done reopens), so archive + restore
  can't reopen a paid task.
- Archiving stops the cycle clock (no "missed" rows while archived);
  un-archiving starts a fresh window.

## Stats

`GET /api/points/summary?period=day|week|month|year&date=YYYY-MM-DD`: per
member points, points per day (over the days of the period elapsed so far),
award count and queued points; household total and averages per person.
`GET /api/points/awards` is the ledger. `POST /api/points/awards/void` (head).
`POST /api/tasks/completions/undo`.
