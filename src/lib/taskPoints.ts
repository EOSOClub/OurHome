// Task time-to-complete (TTC) and points: the pure rules shared by the task
// editor (live, as you type), the server (every save is normalized here), and
// the Android app (mirrored in data/TaskPoints.kt - keep the two in sync).
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
//   points never changes time. A step whose points follow time is always worth
//   its minutes at the task's rate.
// - A task with steps shows *live* totals: the sum of its steps.
// - "Steps share the task's time" (saved per task, on for new tasks): while the
//   task has a time, it is held. The steps not set by hand split what the
//   hand-set ones leave; editing a step's time takes the difference from the
//   other steps or gives it back (the ones not set by hand first), and adding
//   or removing a step re-splits it the same way. Off: editing a step changes
//   only that step, so the live totals float.
// - Editing a task total redistributes that dimension across the steps in
//   proportion to their current time. If that overwrites a hand-set step value,
//   it needs confirmation, and confirming clears the customization it overwrites.
// - Steps not sharing time: adding/removing a step redistributes the base
//   totals while no step is customized; once one is, totals float (a new step
//   gets the average time).

export const DEFAULT_MINUTES_PER_POINT = 10;

export interface TaskPointsBase {
  /** Task-level TTC the user set (null = none). */
  baseMinutes: number | null;
  /** Task-level points, in hundredths (null = none). */
  basePointsCenti: number | null;
  pointsFollowTime: boolean;
  /** Steps share the task's time (held total); off or missing = steps add up. */
  stepsShareTime?: boolean;
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
  /** The edit would overwrite customized steps; nothing changed. Re-run with
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

/** "3.5", "6.79", "12": a point value for display. */
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
 * Splits a whole-number `total` in proportion to `weights` (by the largest
 * remainder method), so the parts sum to exactly `total`. All-zero (or no) weights split evenly.
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

/** The task's time is held: steps share it (it needs a time above zero). */
export function holdsTime(task: TaskPointsBase): boolean {
  return !!task.stepsShareTime && task.baseMinutes !== null && task.baseMinutes > 0;
}

/** Points per minute (hundredths) of a task that holds its time. */
function heldRate(task: TaskPointsBase): number {
  return (task.basePointsCenti ?? 0) / (task.baseMinutes ?? 1);
}

/** Every step whose points follow time gets its minutes at `rateCenti`, split
 *  together so the parts add up exactly (rounding each alone could drift). */
function followPoints<S extends StepPoints>(steps: S[], rateCenti: number): S[] {
  const following = steps.flatMap((s, i) => (s.pointsFollowTime ? [i] : []));
  if (following.length === 0) return steps;
  const minutes = following.map((i) => steps[i].minutes);
  const parts = distribute(
    Math.round(rateCenti * minutes.reduce((a, b) => a + b, 0)),
    minutes,
  );
  const out = [...steps];
  following.forEach((i, k) => {
    out[i] = { ...steps[i], pointsCenti: parts[k] };
  });
  return out;
}

/** Gives `pool` minutes to the steps at `takers`, in proportion to their time. */
function shareOut<S extends StepPoints>(steps: S[], takers: number[], pool: number): S[] {
  const parts = distribute(pool, takers.map((i) => steps[i].minutes));
  const out = [...steps];
  takers.forEach((i, k) => {
    out[i] = { ...steps[i], minutes: parts[k] };
  });
  return out;
}

/** Of the steps at `indices`, the ones that take up time changes: those whose
 *  time wasn't set by hand, or all of them when every one was. */
function takersOf(steps: StepPoints[], indices: number[]): number[] {
  const free = indices.filter((i) => !steps[i].minutesCustom);
  return free.length > 0 ? free : indices;
}

/**
 * Set the task's TTC. With points following time, the base points follow too,
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
 *  rate) or off (keep the current points, now hand-set). Turning it on gives
 *  every step its own time's worth, so the task is worth the time its steps
 *  show; it only asks first when a step's points were set by hand. */
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
  const { steps } = state;
  if (steps.length === 0) return { state: { task, steps }, needsConfirm: false };
  if (steps.some((s) => !s.pointsFollowTime) && !opts.confirm) return { state, needsConfirm: true };
  return {
    state: {
      task,
      steps: followPoints(
        steps.map((s) => ({ ...s, pointsFollowTime: true })),
        taskRateCenti(task, minutesPerPoint),
      ),
    },
    needsConfirm: false,
  };
}

function redistribute<S extends StepPoints>(
  state: PointsState<S>,
  task: TaskPointsBase,
  dims: { minutes: boolean; points: boolean },
  opts: { confirm?: boolean },
): EditResult<S> {
  const { steps } = state;
  if (steps.length === 0) return { state: { task, steps }, needsConfirm: false };
  // Only a hand-set value in a dimension being rescaled needs an OK.
  const overwrites = steps.some(
    (s) => (dims.minutes && s.minutesCustom) || (dims.points && !s.pointsFollowTime),
  );
  if (overwrites && !opts.confirm) return { state, needsConfirm: true };

  const minutes = dims.minutes
    ? distribute(task.baseMinutes ?? 0, steps.map((s) => s.minutes))
    : steps.map((s) => s.minutes);
  // Points split by time, so each step is worth its share of the work. A task
  // holding its time pays its rate for the time on steps (all of it, unless
  // a lone step was set below the task's time); otherwise exactly the total.
  const onSteps = minutes.reduce((a, b) => a + b, 0);
  const pointsTotal = holdsTime(task) ? Math.round(heldRate(task) * onSteps) : task.basePointsCenti ?? 0;
  const points = dims.points ? distribute(pointsTotal, minutes) : steps.map((s) => s.pointsCenti);
  return {
    state: {
      task,
      steps: steps.map((s, i) => ({
        ...s,
        minutes: minutes[i],
        pointsCenti: points[i],
        // Confirming clears the customization of each dimension it rescaled.
        minutesCustom: dims.minutes ? false : s.minutesCustom,
        pointsFollowTime: dims.points ? true : s.pointsFollowTime,
      })),
    },
    needsConfirm: false,
  };
}

/**
 * Set one step's TTC by hand (it is marked customized). Its points follow
 * (task rate) unless they're hand-set.
 *
 * Steps sharing a held time: the other steps make room or take back the
 * difference, in proportion to their time; the ones not set by hand go first,
 * and when every other one was, they all do. The step can't take more than
 * the task's time minus what hand-set steps that don't move keep. A lone step
 * set below the task's time leaves the rest unassigned until a step is added.
 *
 * Otherwise other steps and the task base are untouched.
 */
export function setStepMinutes<S extends StepPoints>(
  state: PointsState<S>,
  index: number,
  minutes: number,
  minutesPerPoint: number,
): PointsState<S> {
  const { task, steps } = state;
  if (!holdsTime(task)) {
    return mapStep(state, index, (s) => ({
      ...s,
      minutes,
      minutesCustom: true,
      pointsCenti: s.pointsFollowTime
        ? stepPointsFromTime(task, minutes, minutesPerPoint)
        : s.pointsCenti,
    }));
  }
  const total = task.baseMinutes ?? 0;
  const others = steps.flatMap((_, i) => (i === index ? [] : [i]));
  const takers = takersOf(steps, others);
  const kept = others.filter((i) => !takers.includes(i)).reduce((a, i) => a + steps[i].minutes, 0);
  const room = Math.max(0, total - kept);
  const value = Math.min(Math.max(0, minutes), room);
  let next = steps.map((s, i) => (i === index ? { ...s, minutes: value, minutesCustom: true } : s));
  if (takers.length > 0) next = shareOut(next, takers, room - value);
  return { task, steps: followPoints(next, heldRate(task)) };
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
  if (on && holdsTime(state.task)) {
    const steps = state.steps.map((s, i) => (i === index ? { ...s, pointsFollowTime: true } : s));
    return { ...state, steps: followPoints(steps, heldRate(state.task)) };
  }
  return mapStep(state, index, (s) =>
    on
      ? { ...s, pointsFollowTime: true, pointsCenti: stepPointsFromTime(state.task, s.minutes, minutesPerPoint) }
      : { ...s, pointsFollowTime: false },
  );
}

/**
 * Turn "Steps share the task's time" on or off. Turning it on holds what the
 * task shows now: a task whose steps had drifted from its set time takes their
 * sum as its time (and their points as its points, when those are hand-set),
 * so no number on screen changes.
 */
export function setStepsShareTime<S extends StepPoints>(
  state: PointsState<S>,
  on: boolean,
  minutesPerPoint: number,
): PointsState<S> {
  const task: TaskPointsBase = { ...state.task, stepsShareTime: on };
  const live = liveTotals(state);
  if (!on || state.steps.length === 0 || live.minutes === 0 || live.minutes === task.baseMinutes) {
    return { ...state, task };
  }
  task.baseMinutes = live.minutes;
  task.basePointsCenti = task.pointsFollowTime ? followedPoints(task, minutesPerPoint) : live.pointsCenti;
  return { ...state, task };
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
 * base.
 *
 * Steps sharing a held time: the new step joins the steps not set by hand,
 * weighted like an average one, and they split what the hand-set steps leave
 * (all of it when every step was set by hand).
 *
 * Otherwise, while nothing is customized, the base is re-split with the new
 * step weighted like an average one; once something is, totals float and the
 * new step gets the average time, with its points following that time.
 */
export function addStep<S extends StepPoints>(
  state: PointsState<S>,
  extra: Omit<S, keyof StepPoints>,
  minutesPerPoint: number,
): PointsState<S> {
  const { task, steps } = state;
  const fresh = (minutes: number, pointsCenti: number) =>
    ({ ...extra, minutes, pointsCenti, minutesCustom: false, pointsFollowTime: true }) as S;

  if (steps.length === 0) {
    return { task, steps: [fresh(task.baseMinutes ?? 0, task.basePointsCenti ?? 0)] };
  }
  if (holdsTime(task)) {
    const free = steps.flatMap((s, i) => (s.minutesCustom ? [] : [i]));
    const kept = steps.reduce((a, s) => a + (s.minutesCustom ? s.minutes : 0), 0);
    const average = free.length > 0 ? free.reduce((a, i) => a + steps[i].minutes, 0) / free.length : 1;
    const next = [...steps, fresh(average, 0)];
    const shared = shareOut(next, [...free, steps.length], Math.max(0, (task.baseMinutes ?? 0) - kept));
    return { task, steps: followPoints(shared, heldRate(task)) };
  }
  const avgMinutes = steps.reduce((a, s) => a + s.minutes, 0) / steps.length;
  const avgPoints = steps.reduce((a, s) => a + s.pointsCenti, 0) / steps.length;
  if (customisedCount(steps) > 0) {
    const minutes = Math.round(avgMinutes);
    return { task, steps: [...steps, fresh(minutes, stepPointsFromTime(task, minutes, minutesPerPoint))] };
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

/** Remove a step. Steps sharing a held time: its time goes back to the steps
 *  not set by hand (to all of them when every one was). Otherwise its share
 *  goes back to the others while nothing is customized; else totals shrink. */
export function removeStep<S extends StepPoints>(state: PointsState<S>, index: number): PointsState<S> {
  const { task } = state;
  const steps = state.steps.filter((_, i) => i !== index);
  if (steps.length > 0 && holdsTime(task)) {
    const takers = takersOf(steps, steps.map((_, i) => i));
    const kept = steps.reduce((a, s, i) => a + (takers.includes(i) ? 0 : s.minutes), 0);
    const shared = shareOut(steps, takers, Math.max(0, (task.baseMinutes ?? 0) - kept));
    return { task, steps: followPoints(shared, heldRate(task)) };
  }
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
 * the base, evenly. Valued rows pass through untouched. A task saved before
 * "Steps share the task's time" gets it on when its steps add up to its time
 * (nothing changes for it), off when they had drifted (so they stay as saved).
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
  const onSteps = usedMinutes + minutes.reduce((a, b) => a + b, 0);
  base.stepsShareTime =
    task.stepsShareTime ?? (steps.length === 0 || base.baseMinutes === null || onSteps === base.baseMinutes);
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
