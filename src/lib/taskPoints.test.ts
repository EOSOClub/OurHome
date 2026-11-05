import { describe, expect, it } from 'vitest';
import {
  addStep,
  customisedCount,
  distribute,
  formatPoints,
  liveTotals,
  pointsForMinutesCenti,
  removeStep,
  setStepFollow,
  setStepMinutes,
  setStepPoints,
  setStepsShareTime,
  setTaskFollow,
  setTaskMinutes,
  setTaskPoints,
  toCenti,
  withDefaults,
  type PointsState,
  type StepPoints,
} from '@/lib/taskPoints';

const RATE = 10; // minutes per point

function step(minutes: number, pointsCenti: number, extra: Partial<StepPoints> = {}): StepPoints {
  return { minutes, pointsCenti, minutesCustom: false, pointsFollowTime: true, ...extra };
}

/** 60 min / 6 pts, three even steps. */
function kitchen(): PointsState {
  return {
    task: { baseMinutes: 60, basePointsCenti: 600, pointsFollowTime: true },
    steps: [step(20, 200), step(20, 200), step(20, 200)],
  };
}

describe('distribute', () => {
  it('always sums exactly and gives the odd unit to the last tie', () => {
    expect(distribute(1000, [1, 1, 1])).toEqual([333, 333, 334]);
    expect(distribute(679, [1, 1])).toEqual([339, 340]);
  });

  it('keeps proportions and splits evenly when every weight is zero', () => {
    expect(distribute(90, [10, 20, 30])).toEqual([15, 30, 45]);
    expect(distribute(10, [0, 0])).toEqual([5, 5]);
    expect(distribute(5, [])).toEqual([]);
  });
});

describe('formatting', () => {
  it('converts and prints decimals', () => {
    expect(toCenti(6.789)).toBe(679);
    expect(formatPoints(350)).toBe('3.5');
    expect(formatPoints(679)).toBe('6.79');
    expect(formatPoints(1200)).toBe('12');
    expect(pointsForMinutesCenti(45, RATE)).toBe(450);
  });
});

describe('task totals', () => {
  it('TTC drives points while they follow time, and both redistribute', () => {
    const { state, needsConfirm } = setTaskMinutes(kitchen(), 90, RATE);
    expect(needsConfirm).toBe(false);
    expect(state.task.basePointsCenti).toBe(900);
    expect(state.steps.map((s) => s.minutes)).toEqual([30, 30, 30]);
    expect(state.steps.map((s) => s.pointsCenti)).toEqual([300, 300, 300]);
  });

  it('hand-set points stop following time and never change TTC', () => {
    const { state } = setTaskPoints(kitchen(), 1000);
    expect(state.task).toEqual({ baseMinutes: 60, basePointsCenti: 1000, pointsFollowTime: false });
    expect(state.steps.map((s) => s.minutes)).toEqual([20, 20, 20]);
    expect(state.steps.map((s) => s.pointsCenti)).toEqual([333, 333, 334]);
  });

  it('TTC change with hand-set points redistributes time only', () => {
    const start = setTaskPoints(kitchen(), 1000).state;
    const { state } = setTaskMinutes(start, 30, RATE);
    expect(state.task.basePointsCenti).toBe(1000);
    expect(state.steps.map((s) => s.minutes)).toEqual([10, 10, 10]);
    expect(state.steps.map((s) => s.pointsCenti)).toEqual([333, 333, 334]);
  });

  it('turning follow back on recalculates from the household rate', () => {
    const start = setTaskPoints(kitchen(), 1000).state;
    const { state } = setTaskFollow(start, true, RATE);
    expect(state.task.basePointsCenti).toBe(600);
    expect(state.task.pointsFollowTime).toBe(true);
  });

  it('asks before overwriting customised steps; confirming rescales and clears markers', () => {
    const custom = setStepMinutes(kitchen(), 0, 40, RATE);
    const ask = setTaskMinutes(custom, 120, RATE);
    expect(ask.needsConfirm).toBe(true);
    expect(ask.state).toBe(custom); // cancel = nothing changed

    const { state } = setTaskMinutes(custom, 120, RATE, { confirm: true });
    expect(state.steps.map((s) => s.minutes)).toEqual([60, 30, 30]); // 40:20:20 kept
    expect(customisedCount(state.steps)).toBe(0);
    expect(liveTotals(state)).toEqual({ minutes: 120, pointsCenti: 1200 });
  });

  it('a task with no steps just takes the values', () => {
    const { state } = setTaskMinutes({ task: { baseMinutes: null, basePointsCenti: null, pointsFollowTime: true }, steps: [] }, 45, RATE);
    expect(liveTotals(state)).toEqual({ minutes: 45, pointsCenti: 450 });
  });
});

describe('step edits', () => {
  it('step TTC recalculates its points at the task rate; others and the base stay', () => {
    const hand = setTaskPoints(kitchen(), 1200).state; // 60 min / 12 pts = 0.2 pt/min
    const state = setStepMinutes(hand, 1, 30, RATE);
    expect(state.steps[1]).toMatchObject({ minutes: 30, pointsCenti: 600, minutesCustom: true });
    expect(state.steps[0]).toEqual(hand.steps[0]);
    expect(state.task).toEqual(hand.task); // no circular recalculation
    expect(liveTotals(state)).toEqual({ minutes: 70, pointsCenti: 1400 });
  });

  it('step points never change its time, and a hand-set step keeps its points on a TTC edit', () => {
    let state = setStepPoints(kitchen(), 0, 500);
    expect(state.steps[0]).toMatchObject({ minutes: 20, pointsCenti: 500, pointsFollowTime: false });
    state = setStepMinutes(state, 0, 25, RATE);
    expect(state.steps[0]).toMatchObject({ minutes: 25, pointsCenti: 500 });
  });

  it('follow toggle recalculates the step from its own time', () => {
    const state = setStepFollow(setStepPoints(kitchen(), 2, 999), 2, true, RATE);
    expect(state.steps[2]).toMatchObject({ pointsCenti: 200, pointsFollowTime: true });
  });
});

describe('adding and removing steps', () => {
  it('the first step takes the whole base; later ones re-split it', () => {
    const empty: PointsState = { task: { baseMinutes: 30, basePointsCenti: 300, pointsFollowTime: true }, steps: [] };
    const one = addStep(empty, {}, RATE);
    expect(one.steps).toEqual([step(30, 300)]);
    const two = addStep(one, {}, RATE);
    expect(liveTotals(two)).toEqual({ minutes: 30, pointsCenti: 300 });
    expect(two.steps.map((s) => s.pointsCenti)).toEqual([150, 150]);
  });

  it('with a customised step, totals float', () => {
    const custom = setStepMinutes(kitchen(), 0, 40, RATE); // 40/20/20, 400/200/200
    const added = addStep(custom, {}, RATE);
    // The average time of the three, worth that time (not the average points).
    expect(added.steps[3]).toEqual(step(27, 270));
    expect(added.steps.slice(0, 3)).toEqual(custom.steps);
    const removed = removeStep(custom, 2);
    expect(liveTotals(removed)).toEqual({ minutes: 60, pointsCenti: 600 });
  });

  it('removing without customisation hands the share back', () => {
    const state = removeStep(kitchen(), 0);
    expect(state.steps.map((s) => s.minutes)).toEqual([30, 30]);
    expect(liveTotals(state)).toEqual({ minutes: 60, pointsCenti: 600 });
  });
});

describe('withDefaults (rows from before points)', () => {
  it('derives points from the old estimate and splits steps evenly', () => {
    const state = withDefaults({ legacyMinutes: 45 }, [{}, {}, {}], RATE);
    expect(state.task).toEqual({ baseMinutes: 45, basePointsCenti: 450, pointsFollowTime: true, stepsShareTime: true });
    expect(state.steps.map((s) => s.minutes)).toEqual([15, 15, 15]);
    expect(state.steps.map((s) => s.pointsCenti)).toEqual([150, 150, 150]);
  });

  it('no estimate means no points; valued steps pass through', () => {
    expect(liveTotals(withDefaults({}, [], RATE))).toEqual({ minutes: 0, pointsCenti: 0 });
    const mixed = withDefaults({ baseMinutes: 60, basePointsCenti: 600, pointsFollowTime: true }, [step(40, 400, { minutesCustom: true }), {}], RATE);
    expect(mixed.steps[1]).toEqual(step(20, 200));
  });

  it('a task from before the share switch gets it on only when its steps add up', () => {
    const base = { baseMinutes: 20, basePointsCenti: 200, pointsFollowTime: true };
    expect(withDefaults(base, [step(10, 100), step(10, 100)], RATE).task.stepsShareTime).toBe(true);
    expect(withDefaults(base, [step(10, 100), step(15, 150)], RATE).task.stepsShareTime).toBe(false);
    expect(withDefaults({ ...base, stepsShareTime: true }, [step(10, 100), step(15, 150)], RATE).task.stepsShareTime).toBe(true);
  });
});

/** 30 min / 3 pts, three even steps sharing the time. */
function shared(): PointsState {
  return {
    task: { baseMinutes: 30, basePointsCenti: 300, pointsFollowTime: true, stepsShareTime: true },
    steps: [step(10, 100), step(10, 100), step(10, 100)],
  };
}

const minutesOf = (state: PointsState) => state.steps.map((s) => s.minutes);

describe('steps sharing the task time', () => {
  it('a step edit moves the difference to the other steps; the total holds', () => {
    // Whole minutes: 25 over two steps is 12 + 13.
    const less = setStepMinutes(shared(), 1, 5, RATE);
    expect(minutesOf(less)).toEqual([12, 5, 13]);
    expect(less.steps[1].minutesCustom).toBe(true);
    expect(less.task).toEqual(shared().task);

    const back = setStepMinutes(less, 1, 10, RATE);
    expect(minutesOf(back)).toEqual([10, 10, 10]);

    const more = setStepMinutes(back, 1, 20, RATE);
    expect(minutesOf(more)).toEqual([5, 20, 5]);
    expect(more.steps.map((s) => s.pointsCenti)).toEqual([50, 200, 50]);
    expect(liveTotals(more)).toEqual({ minutes: 30, pointsCenti: 300 });
  });

  it('20 min task: a 10 min step then a 15 min step keeps 20', () => {
    const task = { baseMinutes: 20, basePointsCenti: 200, pointsFollowTime: true, stepsShareTime: true };
    let state: PointsState = addStep({ task, steps: [] }, {}, RATE);
    state = setStepMinutes(state, 0, 10, RATE); // the other 10 waits for a step
    expect(liveTotals(state)).toEqual({ minutes: 10, pointsCenti: 100 });
    state = addStep(state, {}, RATE);
    expect(minutesOf(state)).toEqual([10, 10]);
    state = setStepMinutes(state, 1, 15, RATE);
    expect(minutesOf(state)).toEqual([5, 15]);
    expect(liveTotals(state)).toEqual({ minutes: 20, pointsCenti: 200 });
  });

  it('steps set by hand keep their time while the others make room', () => {
    let state = setStepMinutes(shared(), 0, 5, RATE); // 5 / 12 / 13
    state = setStepMinutes(state, 1, 20, RATE);
    expect(minutesOf(state)).toEqual([5, 20, 5]);
    // No more room than the task's time minus the hand-set 5.
    state = setStepMinutes(state, 1, 40, RATE);
    expect(minutesOf(state)).toEqual([5, 25, 0]);
    expect(liveTotals(state).minutes).toBe(30);
  });

  it('when every other step was set by hand, they all make room', () => {
    let state = setStepMinutes(shared(), 0, 5, RATE);
    state = setStepMinutes(state, 1, 5, RATE); // 5 / 5 / 20, all set by hand
    state = setStepMinutes(state, 2, 10, RATE);
    expect(minutesOf(state)).toEqual([10, 10, 10]);
  });

  it('adding and removing re-split what the hand-set steps leave', () => {
    const one = setStepMinutes(shared(), 0, 6, RATE); // 6 / 12 / 12
    const added = addStep(one, {}, RATE);
    expect(minutesOf(added)).toEqual([6, 8, 8, 8]);
    expect(liveTotals(added)).toEqual({ minutes: 30, pointsCenti: 300 });
    const removed = removeStep(added, 1);
    expect(minutesOf(removed)).toEqual([6, 12, 12]);
    expect(liveTotals(removed)).toEqual({ minutes: 30, pointsCenti: 300 });
  });

  it('hand-set step points stay put while time moves', () => {
    let state = setStepPoints(shared(), 0, 500);
    state = setStepMinutes(state, 1, 20, RATE);
    expect(state.steps.map((s) => s.pointsCenti)).toEqual([500, 200, 50]);
  });

  it('a task without a time has nothing to hold: steps add up', () => {
    const task = { baseMinutes: null, basePointsCenti: null, pointsFollowTime: true, stepsShareTime: true };
    const state = setStepMinutes({ task, steps: [step(0, 0), step(0, 0)] }, 0, 10, RATE);
    expect(minutesOf(state)).toEqual([10, 0]);
  });

  it('turning the switch on holds what the task shows', () => {
    const drifted: PointsState = {
      task: { baseMinutes: 20, basePointsCenti: 200, pointsFollowTime: true, stepsShareTime: false },
      steps: [step(10, 100, { minutesCustom: true }), step(15, 150, { minutesCustom: true })],
    };
    const on = setStepsShareTime(drifted, true, RATE);
    expect(on.task).toMatchObject({ baseMinutes: 25, basePointsCenti: 250, stepsShareTime: true });
    expect(on.steps).toEqual(drifted.steps);
    expect(setStepsShareTime(on, false, RATE).task.baseMinutes).toBe(25);
  });
});

describe('points follow time, back on', () => {
  // The reported bug: 20 min task, steps 10 and 15 min (1 and 1.5 pts) that
  // add up past it. Off then on made the 15 min step 1.2 pts.
  const drifted = (): PointsState => ({
    task: { baseMinutes: 20, basePointsCenti: 200, pointsFollowTime: true },
    steps: [step(10, 100, { minutesCustom: true }), step(15, 150, { minutesCustom: true })],
  });

  it("gives every step its own time's worth, without asking over hand-set times", () => {
    const off = setTaskFollow(drifted(), false, RATE).state;
    const on = setTaskFollow(off, true, RATE);
    expect(on.needsConfirm).toBe(false);
    expect(on.state.steps.map((s) => s.pointsCenti)).toEqual([100, 150]);
    // The step's own switch agrees.
    expect(setStepFollow(on.state, 1, true, RATE).steps[1].pointsCenti).toBe(150);
  });

  it('still asks before overwriting hand-set step points', () => {
    const hand = setStepPoints(drifted(), 1, 500);
    expect(setTaskFollow(setTaskFollow(hand, false, RATE).state, true, RATE).needsConfirm).toBe(true);
  });
});
