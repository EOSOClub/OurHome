'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Repeat, X } from 'lucide-react';
import type { TaskDTO } from '@/lib/types';
import {
  addStep,
  customisedCount,
  formatPoints,
  liveTotals,
  removeStep,
  setStepFollow,
  setStepMinutes,
  setStepPoints,
  setTaskFollow,
  setTaskMinutes,
  setTaskPoints,
  toCenti,
  type EditResult,
  type PointsState,
  type StepPoints,
} from '@/lib/taskPoints';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// The task editor's time-to-complete / points section and checklist. All the
// arithmetic is src/lib/taskPoints.ts (also what the server applies); this
// file is only the controls. Rules in docs/points.md.

export interface DraftStep extends StepPoints {
  /** React key; `id` is set for items that already exist on the server. */
  key: string;
  id?: string;
  title: string;
  resetIntervalDays: number | null;
}

export type PointsDraft = PointsState<DraftStep>;

let keySeq = 0;
const newKey = () => `new-${++keySeq}`;

/** The editor's starting state for a task (or an empty new task). */
export function draftFromTask(task?: TaskDTO): PointsDraft {
  if (!task) return { task: { baseMinutes: null, basePointsCenti: null, pointsFollowTime: true }, steps: [] };
  return {
    task: {
      baseMinutes: task.baseMinutes,
      basePointsCenti: task.basePoints === null ? null : toCenti(task.basePoints),
      pointsFollowTime: task.pointsFollowTime,
    },
    steps: [...task.subtasks]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        key: s.id,
        id: s.id,
        title: s.title,
        resetIntervalDays: s.resetIntervalDays,
        minutes: s.minutes,
        pointsCenti: toCenti(s.points),
        minutesCustom: s.minutesCustom,
        pointsFollowTime: s.pointsFollowTime,
      })),
  };
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * A number input that keeps its own text while focused (so "", "1." etc. can
 * be typed) and reports parsed values. `onValue` runs on every valid change;
 * `onCommit` on blur/Enter with the last value.
 */
function NumberField({
  value,
  onValue,
  onCommit,
  onFocus,
  decimals = false,
  marked = false,
  ...rest
}: {
  value: number | null;
  onValue?: (v: number | null) => void;
  onCommit?: (v: number | null) => void;
  onFocus?: () => void;
  decimals?: boolean;
  marked?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onFocus'>) {
  const [text, setText] = useState<string | null>(null);
  const parse = (t: string): number | null => {
    if (t.trim() === '') return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return null;
    return decimals ? Math.round(n * 100) / 100 : Math.round(n);
  };
  const shown = text ?? (value === null ? '' : String(value));
  return (
    <Input
      {...rest}
      type="number"
      inputMode={decimals ? 'decimal' : 'numeric'}
      min={0}
      step={decimals ? 0.01 : 1}
      value={shown}
      className={cn(rest.className, marked && 'border-amber-500 ring-1 ring-amber-500/40')}
      onFocus={() => {
        setText(value === null ? '' : String(value));
        onFocus?.();
      }}
      onChange={(e) => {
        setText(e.target.value);
        onValue?.(parse(e.target.value));
      }}
      onBlur={(e) => {
        onCommit?.(parse(e.target.value));
        setText(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

type PendingTotal = { run: (confirm: boolean) => EditResult<DraftStep>; what: string };

export function PointsEditor({
  value,
  onChange,
  minutesPerPoint,
}: {
  value: PointsDraft;
  onChange: (next: PointsDraft) => void;
  minutesPerPoint: number;
}) {
  // Totals are edited against the state from when the field was focused, so
  // typing "1" then "12" scales from the original split, not from "1".
  const [snapshot, setSnapshot] = useState<PointsDraft | null>(null);
  const [pending, setPending] = useState<PendingTotal | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  const live = liveTotals(value);
  const custom = customisedCount(value.steps);
  const base = snapshot ?? value;

  /** Apply a total edit: live while nothing is customised; otherwise ask on commit. */
  function totalLive(run: (confirm: boolean) => EditResult<DraftStep>) {
    const result = run(false);
    if (!result.needsConfirm) onChange(result.state);
  }
  function totalCommit(run: (confirm: boolean) => EditResult<DraftStep>, what: string) {
    setSnapshot(null);
    const result = run(false);
    if (result.needsConfirm) setPending({ run, what });
    else onChange(result.state);
  }

  const minutesRun = (v: number | null) => (confirm: boolean) =>
    setTaskMinutes(base, v, minutesPerPoint, { confirm });
  const pointsRun = (v: number | null) => (confirm: boolean) =>
    setTaskPoints(base, v === null ? null : toCenti(v), { confirm });

  function moveStep(index: number, direction: -1 | 1) {
    const steps = [...value.steps];
    const to = index + direction;
    if (to < 0 || to >= steps.length) return;
    [steps[index], steps[to]] = [steps[to], steps[index]];
    onChange({ ...value, steps });
  }

  function addDraftStep() {
    const title = draftTitle.trim();
    if (!title) return;
    onChange(addStep(value, { key: newKey(), title, resetIntervalDays: null }));
    setDraftTitle('');
  }

  const rateLabel =
    minutesPerPoint === 1 ? '1 point per minute' : `1 point per ${formatPoints(toCenti(minutesPerPoint))} min`;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="ttc">Time to complete (min)</Label>
          <NumberField
            id="ttc"
            value={value.steps.length || value.task.baseMinutes !== null ? live.minutes : null}
            placeholder="e.g. 15"
            marked={custom > 0}
            onFocus={() => setSnapshot(value)}
            onValue={(v) => (custom > 0 ? undefined : totalLive(minutesRun(v)))}
            onCommit={(v) => {
              if (v === (value.steps.length ? live.minutes : value.task.baseMinutes)) return setSnapshot(null);
              totalCommit(minutesRun(v), 'time to complete');
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="points">Points</Label>
          <NumberField
            id="points"
            decimals
            value={value.steps.length || value.task.basePointsCenti !== null ? live.pointsCenti / 100 : null}
            placeholder="0"
            marked={custom > 0}
            onFocus={() => setSnapshot(value)}
            onValue={(v) => (custom > 0 ? undefined : totalLive(pointsRun(v)))}
            onCommit={(v) => {
              if (v !== null && toCenti(v) === live.pointsCenti) return setSnapshot(null);
              totalCommit(pointsRun(v), 'points');
            }}
          />
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={value.task.pointsFollowTime}
            onChange={(e) => {
              const on = e.target.checked;
              totalCommit((confirm) => setTaskFollow(value, on, minutesPerPoint, { confirm }), 'points');
            }}
          />
          <span>
            Points follow time
            <span className="block text-xs text-muted-foreground">{rateLabel}</span>
          </span>
        </label>
      </div>

      {custom > 0 ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          Totals influenced by {custom} customised step{custom === 1 ? '' : 's'}
          {value.task.baseMinutes !== null || value.task.basePointsCenti !== null
            ? ` (task set to ${formatMinutes(value.task.baseMinutes ?? 0)} · ${formatPoints(value.task.basePointsCenti ?? 0)} pts)`
            : ''}
          . Changing a total rescales every step and clears their custom values.
        </p>
      ) : null}

      <div className="space-y-2">
        <Label>Checklist{value.steps.length ? '' : ' (optional)'}</Label>
        {value.steps.length > 0 ? (
          <div className="space-y-2">
            <div className="hidden grid-cols-[1fr_5rem_5.5rem_4.5rem_auto] gap-2 px-1 text-xs text-muted-foreground sm:grid">
              <span>Step</span>
              <span>Minutes</span>
              <span>Points</span>
              <span>Resets</span>
              <span />
            </div>
            {value.steps.map((s, i) => (
              <div
                key={s.key}
                className="grid grid-cols-2 gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_5rem_5.5rem_4.5rem_auto] sm:items-center sm:border-0 sm:p-0"
              >
                <Input
                  value={s.title}
                  aria-label="Step title"
                  className="col-span-2 h-9 sm:col-span-1"
                  onChange={(e) =>
                    onChange({ ...value, steps: value.steps.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })
                  }
                />
                <NumberField
                  aria-label="Step minutes"
                  title={s.minutesCustom ? 'Time set by hand' : 'Share of the task time'}
                  className="h-9"
                  value={s.minutes}
                  marked={s.minutesCustom}
                  onValue={(v) => v !== null && onChange(setStepMinutes(value, i, v, minutesPerPoint))}
                />
                <div className="flex items-center gap-1">
                  <NumberField
                    aria-label="Step points"
                    title={s.pointsFollowTime ? 'Follows the step time' : 'Points set by hand'}
                    className="h-9"
                    decimals
                    value={s.pointsCenti / 100}
                    marked={!s.pointsFollowTime}
                    onValue={(v) => v !== null && onChange(setStepPoints(value, i, toCenti(v)))}
                  />
                  <button
                    type="button"
                    title={s.pointsFollowTime ? 'Points follow time (click to keep them fixed)' : 'Make points follow time again'}
                    aria-pressed={s.pointsFollowTime}
                    onClick={() => onChange(setStepFollow(value, i, !s.pointsFollowTime, minutesPerPoint))}
                    className={cn(
                      'rounded p-1 text-muted-foreground hover:text-foreground',
                      s.pointsFollowTime && 'text-primary',
                    )}
                  >
                    <Repeat className="size-3.5" />
                  </button>
                </div>
                <NumberField
                  aria-label="Unchecks every N days"
                  title="Unchecks itself every N days (empty = only with the task)"
                  placeholder="—"
                  className="h-9"
                  value={s.resetIntervalDays}
                  onValue={(v) =>
                    onChange({
                      ...value,
                      steps: value.steps.map((x, j) =>
                        j === i ? { ...x, resetIntervalDays: v && v >= 1 ? Math.min(v, 365) : null } : x,
                      ),
                    })
                  }
                />
                <div className="flex items-center justify-end gap-0.5">
                  <button
                    type="button"
                    aria-label="Move step up"
                    disabled={i === 0}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    onClick={() => moveStep(i, -1)}
                  >
                    <ChevronUp className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move step down"
                    disabled={i === value.steps.length - 1}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    onClick={() => moveStep(i, 1)}
                  >
                    <ChevronDown className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove step"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => onChange(removeStep(value, i))}
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Highlighted values were set by hand. A step&apos;s points follow its time unless you type them (
              <Repeat className="inline size-3" /> switches back).
            </p>
          </div>
        ) : null}
        <div className="flex gap-2">
          <Input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addDraftStep();
              }
            }}
            placeholder="Add a step…"
            className="h-9"
          />
          <Button type="button" variant="outline" size="sm" onClick={addDraftStep} aria-label="Add step">
            <Plus />
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) onChange(pending.run(true).state);
          setPending(null);
        }}
        title="Rescale every step?"
        description={`Some steps have values set by hand. Changing the task's ${pending?.what ?? 'total'} spreads it across all steps in proportion and clears those custom values.`}
        confirmLabel="Rescale steps"
      />
    </div>
  );
}
