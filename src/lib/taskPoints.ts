// Task time-to-complete (TTC) and points: the pure rules shared by the task
// editor (live, as you type), the server (every save is normalised here) and
// the Android app (mirrored in data/TaskPoints.kt — keep the two in step).
//
// Units: minutes are whole minutes; points are integer hundredths ("centi"),
// so 3.33 pts is 333. Splits use largest-remainder rounding, so the parts
// always add up to exactly the total.
//
// The rules (agreed with the household; see docs/points.md):
// - A task has a *base* TTC and base points, set only by task-level edits. Its
//   points-per-minute rate is base points ÷ base minutes (household rate when
//   it has no time). Step edits never change the base, so nothing recalculates
//   in a circle.
// - "Points follow time" (saved per task and per step, on by default): a TTC
//   change recalculates points; typing points by hand turns it off. Changing
//   points never changes time.
// - A task with steps shows *live* totals: the sum of its steps.
// - Editing a step changes only that step (and so the live totals).
// - Editing a task total redistributes that dimension across the steps in
//   proportion to their current values. If any step is customised this needs
//   confirmation, and confirming clears the customisation it overwrites.
// - Adding/removing a step redistributes the base totals while no step is
//   customised; once one is, totals float (a new step gets the average).

export const DEFAULT_MINUTES_PER_POINT = 10;

export interface TaskPointsBase {
  /** Task-level TTC the user set (null = none). */
  baseMinutes: number | null;
  /** Task-level points, in hundredths (null = none). */
  basePointsCenti: number | null;
  pointsFollowTime: boolean;
}

export interface StepPoints {
  minutes: number;
  pointsCenti: number;
  /** The step's time was set by hand. */
  minutesCustom: boolean;
  /** Off = the step's points were set by hand. */
  pointsFollowTime: boolean;
}

export interface PointsState<S extends StepPoints = StepPoints> {
  task: TaskPointsBase;
  steps: S[];
}

export interface EditResult<S extends StepPoints> {
  state: PointsState<S>;
  /** The edit would overwrite customised steps; nothing changed. Re-run with
   *  `confirm: true` after the user agrees. */
  needsConfirm: boolean;
}

/** 3.456 → 346 hundredths. */
export function toCenti(points: number): number {
  return Math.round(points * 100);
}

/** 346 hundredths → 3.46. */
export function fromCenti(centi: number): number {
  return centi / 100;
}

/** "3.5", "6.79", "12": a points value for display. */
export function formatPoints(centi: number): string {
  const value = fromCenti(centi);
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

export function pointsForMinutesCenti(minutes: number, minutesPerPoint: number): number {
  if (minutes <= 0 || minutesPerPoint <= 0) return 0;
  return Math.round((minutes * 100) / minutesPerPoint);
}

/** The task's points-per-minute, in hundredths: base points ÷ base minutes,
 *  or the household rate when the task has no time. */
export function taskRateCenti(task: TaskPointsBase, minutesPerPoint: number): number {
  if (task.baseMinutes && task.baseMinutes > 0 && task.basePointsCenti !== null) {
    return task.basePointsCenti / task.baseMinutes;
  }
  return minutesPerPoint > 0 ? 100 / minutesPerPoint : 0;
}

/**
 * Splits a whole-number `total` in proportion to `weights` (largest remainder),
 * so the parts sum to exactly `total`. All-zero (or no) weights split evenly.
 */
export function distribute(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const safeTotal = Math.max(0, Math.round(total));
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? clean.map((w) => (safeTotal * w) / sum) : clean.map(() => safeTotal / n);
  const parts = shares.map(Math.floor);
  let left = safeTotal - parts.reduce((a, b) => a + b, 0);
  // Hand the leftover units to the largest fractions; ties go to the later
  // step so "10 over 3" reads 3.33 / 3.33 / 3.34.
  const order = shares
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac || b.i - a.i);
  for (const { i } of order) {
    if (left <= 0) break;
    parts[i] += 1;
    left -= 1;
  }
  return parts;
}

/** What the task shows: the sum of its steps, or its base without steps. */
export function liveTotals(state: PointsState): { minutes: number; pointsCenti: number } {
  if (state.steps.length === 0) {
    return {
      minutes: state.task.baseMinutes ?? 0,
      pointsCenti: state.task.basePointsCenti ?? 0,
    };
  }
  return {
    minutes: state.steps.reduce((a, s) => a + s.minutes, 0),
    pointsCenti: state.steps.reduce((a, s) => a + s.pointsCenti, 0),
  };
}

export function isCustomised(step: StepPoints): boolean {
  return step.minutesCustom || !step.pointsFollowTime;
}

/** How many steps carry a hand-set value (drives the "influenced" banner). */
export function customisedCount(steps: StepPoints[]): number {
  return steps.filter(isCustomised).length;
}

/** The base points for a task whose points follow time. */
function followedPoints(task: TaskPointsBase, minutesPerPoint: number): number {
  return pointsForMinutesCenti(task.baseMinutes ?? 0, minutesPerPoint);
}

function stepPointsFromTime(
  task: TaskPointsBase,
  minutes: number,
  minutesPerPoint: number,
): number {
  return Math.round(taskRateCenti(task, minutesPerPoint) * minutes);
}

/**
 * Set the task's TTC. With points following time the base points follow too,
 * and both are redistributed across the steps; otherwise only time is.
 */
export function setTaskMinutes<S extends StepPoints>(
  state: PointsState<S>,
  minutes: number | null,
  minutesPerPoint: number,
  opts: { confirm?: boolean } = {},
): EditResult<S> {
  const task: TaskPointsBase = { ...state.task, baseMinutes: minutes };
  if (task.pointsFollowTime) task.basePointsCenti = followedPoints(task, minutesPerPoint);
  return redistribute(state, task, { minutes: true, points: task.pointsFollowTime }, opts);
}

/** Set the task's points by hand: they stop following time; TTC is untouched. */
export function setTaskPoints<S extends StepPoints>(
  state: PointsState<S>,
  pointsCenti: number | null,
  opts: { confirm?: boolean } = {},
): EditResult<S> {
  const task: TaskPointsBase = { ...state.task, basePointsCenti: pointsCenti, pointsFollowTime: false };
  return redistribute(state, task, { minutes: false, points: true }, opts);
}

/** Turn the task's "Points follow time" on (recalculate from the household
 *  rate) or off (keep the current points, now hand-set). */
export function setTaskFollow<S extends StepPoints>(
  state: PointsState<S>,
  on: boolean,
  minutesPerPoint: number,
  opts: { confirm?: boolean } = {},
): EditResult<S> {
  if (!on) {
    return { state: { ...state, task: { ...state.task, pointsFollowTime: false } }, needsConfirm: false };
  }
  const task: TaskPointsBase = { ...state.task, pointsFollowTime: true };
  task.basePointsCenti = followedPoints(task, minutesPerPoint);
  return redistribute(state, task, { minutes: false, points: true }, opts);
}

function redistribute<S extends StepPoints>(
  state: PointsState<S>,
  task: TaskPointsBase,
  dims: { minutes: boolean; points: boolean },
  opts: { confirm?: boolean },
): EditResult<S> {
  const { steps } = state;
  if (steps.length === 0) return { state: { task, steps }, needsConfirm: false };
  if (customisedCount(steps) > 0 && !opts.confirm) return { state, needsConfirm: true };

  const minutes = dims.minutes
    ? distribute(task.baseMinutes ?? 0, steps.map((s) => s.minutes))
    : steps.map((s) => s.minutes);
  const points = dims.points
    ? distribute(task.basePointsCenti ?? 0, steps.map((s) => s.pointsCenti))
    : steps.map((s) => s.pointsCenti);
  return {
    state: {
      task,
      steps: steps.map((s, i) => ({
        ...s,
        minutes: minutes[i],
        pointsCenti: points[i],
        // Confirming clears the customisation of each dimension it rescaled.
        minutesCustom: dims.minutes ? false : s.minutesCustom,
        pointsFollowTime: dims.points ? true : s.pointsFollowTime,
      })),
    },
    needsConfirm: false,
  };
}

/** Set one step's TTC by hand. Its points follow (task rate) unless they're
 *  hand-set; other steps and the task base are untouched. */
export function setStepMinutes<S extends StepPoints>(
  state: PointsState<S>,
  index: number,
  minutes: number,
  minutesPerPoint: number,
): PointsState<S> {
  return mapStep(state, index, (s) => ({
    ...s,
    minutes,
    minutesCustom: true,
    pointsCenti: s.pointsFollowTime
      ? stepPointsFromTime(state.task, minutes, minutesPerPoint)
      : s.pointsCenti,
  }));
}

/** Set one step's points by hand; its time is untouched. */
export function setStepPoints<S extends StepPoints>(
  state: PointsState<S>,
  index: number,
  pointsCenti: number,
): PointsState<S> {
  return mapStep(state, index, (s) => ({ ...s, pointsCenti, pointsFollowTime: false }));
}

/** Turn a step's "Points follow time" on (recalculate from its time at the
 *  task's rate) or off (keep its points, now hand-set). */
export function setStepFollow<S extends StepPoints>(
  state: PointsState<S>,
  index: number,
  on: boolean,
  minutesPerPoint: number,
): PointsState<S> {
  return mapStep(state, index, (s) =>
    on
      ? { ...s, pointsFollowTime: true, pointsCenti: stepPointsFromTime(state.task, s.minutes, minutesPerPoint) }
      : { ...s, pointsFollowTime: false },
  );
}

function mapStep<S extends StepPoints>(
  state: PointsState<S>,
  index: number,
  fn: (s: S) => S,
): PointsState<S> {
  return { ...state, steps: state.steps.map((s, i) => (i === index ? fn(s) : s)) };
}

/**
 * Add a step (its own fields come from `extra`). The first step takes the whole
 * base; while nothing is customised the base is re-split with the new step
 * weighted like an average one; otherwise totals float and the new step gets
 * the average values.
 */
export function addStep<S extends StepPoints>(
  state: PointsState<S>,
  extra: Omit<S, keyof StepPoints>,
): PointsState<S> {
  const { task, steps } = state;
  const fresh = (minutes: number, pointsCenti: number) =>
    ({ ...extra, minutes, pointsCenti, minutesCustom: false, pointsFollowTime: true }) as S;

  if (steps.length === 0) {
    return { task, steps: [fresh(task.baseMinutes ?? 0, task.basePointsCenti ?? 0)] };
  }
  const avgMinutes = steps.reduce((a, s) => a + s.minutes, 0) / steps.length;
  const avgPoints = steps.reduce((a, s) => a + s.pointsCenti, 0) / steps.length;
  if (customisedCount(steps) > 0) {
    return { task, steps: [...steps, fresh(Math.round(avgMinutes), Math.round(avgPoints))] };
  }
  const minutes = distribute(task.baseMinutes ?? 0, [...steps.map((s) => s.minutes), avgMinutes]);
  const points = distribute(task.basePointsCenti ?? 0, [...steps.map((s) => s.pointsCenti), avgPoints]);
  return {
    task,
    steps: [
      ...steps.map((s, i) => ({ ...s, minutes: minutes[i], pointsCenti: points[i] })),
      fresh(minutes[steps.length], points[steps.length]),
    ],
  };
}

/** Remove a step: its share goes back to the others while nothing is
 *  customised; otherwise totals shrink. */
export function removeStep<S extends StepPoints>(state: PointsState<S>, index: number): PointsState<S> {
  const { task } = state;
  const steps = state.steps.filter((_, i) => i !== index);
  if (steps.length === 0 || customisedCount(state.steps) > 0) return { task, steps };
  const minutes = distribute(task.baseMinutes ?? 0, steps.map((s) => s.minutes));
  const points = distribute(task.basePointsCenti ?? 0, steps.map((s) => s.pointsCenti));
  return {
    task,
    steps: steps.map((s, i) => ({ ...s, minutes: minutes[i], pointsCenti: points[i] })),
  };
}

/**
 * Fills in values for rows saved before points existed (or by an older app):
 * a task without base values takes its time from `legacyMinutes` with points
 * following time; steps without values share what the valued steps leave of
 * the base, evenly. Valued rows pass through untouched.
 */
export function withDefaults<S extends Partial<StepPoints>>(
  task: Partial<TaskPointsBase> & { legacyMinutes?: number | null },
  steps: S[],
  minutesPerPoint: number,
): PointsState<S & StepPoints> {
  const baseMinutes = task.baseMinutes ?? task.legacyMinutes ?? null;
  const follow = task.pointsFollowTime ?? true;
  const base: TaskPointsBase = {
    baseMinutes,
    basePointsCenti:
      task.basePointsCenti ?? (baseMinutes !== null ? pointsForMinutesCenti(baseMinutes, minutesPerPoint) : null),
    pointsFollowTime: task.basePointsCenti == null ? true : follow,
  };
  const missing = steps.map((s) => s.minutes == null || s.pointsCenti == null);
  const missingCount = missing.filter(Boolean).length;
  const usedMinutes = steps.reduce((a, s, i) => a + (missing[i] ? 0 : s.minutes ?? 0), 0);
  const usedPoints = steps.reduce((a, s, i) => a + (missing[i] ? 0 : s.pointsCenti ?? 0), 0);
  const even = (total: number) => distribute(Math.max(0, total), new Array(missingCount).fill(1));
  const minutes = even((base.baseMinutes ?? 0) - usedMinutes);
  const points = even((base.basePointsCenti ?? 0) - usedPoints);
  let k = 0;
  return {
    task: base,
    steps: steps.map((s, i) => {
      if (!missing[i]) {
        return {
          ...s,
          minutes: s.minutes!,
          pointsCenti: s.pointsCenti!,
          minutesCustom: s.minutesCustom ?? false,
          pointsFollowTime: s.pointsFollowTime ?? true,
        };
      }
      const j = k++;
      return { ...s, minutes: minutes[j], pointsCenti: points[j], minutesCustom: false, pointsFollowTime: true };
    }),
  };
}
