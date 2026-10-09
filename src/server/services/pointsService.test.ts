import { describe, expect, it } from 'vitest';
import {
  UNDO_WINDOW_MS,
  canUndo,
  checkOutcome,
  effectivePoints,
  planPayout,
  settingsFrom,
  type PayoutStep,
} from '@/server/services/pointsService';

const NOW = new Date('2026-10-09T15:00:00Z');
const EARLIER = new Date('2026-10-09T13:00:00Z');

function step(id: string, pointsCenti: number, pendingUser?: string): PayoutStep {
  return {
    id,
    title: `Step ${id}`,
    pointsCenti,
    pending: pendingUser ? { userId: pendingUser, checkedAt: EARLIER } : null,
  };
}

describe('planPayout', () => {
  it('pays queued steps to whoever checked them and the rest to the completer', () => {
    const awards = planPayout({
      taskPointsCenti: 1000,
      steps: [step('a', 300, 'kid'), step('b', 700)],
      completerId: 'mom',
      now: NOW,
    });
    expect(awards.map((a) => [a.userId, a.subtaskId, a.pointsCenti])).toEqual([
      ['kid', 'a', 300],
      ['mom', 'b', 700],
    ]);
    expect(awards[0].earnedAt).toEqual(EARLIER); // when the work was done
    expect(awards[1].earnedAt).toEqual(NOW);
    expect(awards.reduce((a, w) => a + w.pointsCenti, 0)).toBe(1000);
  });

  it('a task without steps pays its points to the completer', () => {
    const awards = planPayout({ taskPointsCenti: 450, steps: [], completerId: 'dad', now: NOW });
    expect(awards).toEqual([
      { userId: 'dad', subtaskId: null, kind: 'task', pointsCenti: 450, stepTitle: null, earnedAt: NOW },
    ]);
  });

  it('skips zero-point rows', () => {
    expect(planPayout({ taskPointsCenti: 0, steps: [], completerId: 'x', now: NOW })).toEqual([]);
    expect(planPayout({ taskPointsCenti: 300, steps: [step('a', 0), step('b', 300)], completerId: 'x', now: NOW })).toHaveLength(1);
  });
});

describe('checkOutcome', () => {
  const base = { alreadyDone: false, taskFinished: false, hasPending: false, autoReset: false };

  it('a first check queues', () => {
    expect(checkOutcome(base)).toBe('queue');
  });

  it('a re-check after the step reset itself pays at once', () => {
    expect(checkOutcome({ ...base, hasPending: true, autoReset: true })).toBe('pay_now');
    expect(checkOutcome({ ...base, taskFinished: true, autoReset: true })).toBe('pay_now');
  });

  it('unchecking and re-checking by hand never earns twice', () => {
    expect(checkOutcome({ ...base, hasPending: true })).toBe('nothing');
    expect(checkOutcome({ ...base, taskFinished: true })).toBe('nothing');
    expect(checkOutcome({ ...base, alreadyDone: true, autoReset: true })).toBe('nothing');
  });
});

describe('canUndo', () => {
  const completion = { completedById: 'kid', completedAt: NOW };

  it('the completer has 10 minutes', () => {
    const inWindow = new Date(NOW.getTime() + UNDO_WINDOW_MS);
    const late = new Date(NOW.getTime() + UNDO_WINDOW_MS + 1);
    expect(canUndo({ ...completion, actor: { id: 'kid', role: 'child' }, now: inWindow })).toBe(true);
    expect(canUndo({ ...completion, actor: { id: 'kid', role: 'child' }, now: late })).toBe(false);
  });

  it('nobody else but the head, who may any time', () => {
    const later = new Date(NOW.getTime() + 86_400_000);
    expect(canUndo({ ...completion, actor: { id: 'mgr', role: 'manager' }, now: NOW })).toBe(false);
    expect(canUndo({ ...completion, actor: { id: 'mom', role: 'head' }, now: later })).toBe(true);
  });
});

describe('settings and legacy rows', () => {
  it('fills defaults and rejects a bad zone or rate', () => {
    expect(settingsFrom(null)).toEqual({ timezone: 'America/Chicago', weekStartsOn: 0, minutesPerPoint: 10 });
    expect(settingsFrom({ timezone: 'Not/AZone', weekStartsOn: 1, minutesPerPoint: 0 })).toEqual({
      timezone: 'America/Chicago',
      weekStartsOn: 1,
      minutesPerPoint: 10,
    });
  });

  it('a task saved before points gets its value from the old estimate', () => {
    const state = effectivePoints(
      {
        estimatedMinutes: 30,
        baseMinutes: null,
        basePointsCenti: null,
        pointsFollowTime: null,
        subtasks: [
          { minutes: null, pointsCenti: null, minutesCustom: null, pointsFollowTime: null },
          { minutes: null, pointsCenti: null, minutesCustom: null, pointsFollowTime: null },
        ],
      },
      10,
    );
    expect(state.steps.map((s) => s.pointsCenti)).toEqual([150, 150]);
  });
});
