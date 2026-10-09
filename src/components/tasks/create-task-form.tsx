'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { CategoryDTO, MemberDTO, TaskDTO } from '@/lib/types';
import {
  TASK_PRIORITIES,
  TASK_TYPES,
  TASK_TYPE_LABELS,
  PRIORITY_LABELS,
} from '@/lib/enums';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  PointsEditor,
  draftFromTask,
  type PointsDraft,
} from '@/components/tasks/points-editor';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const WEEKDAY_VALUES = [1, 2, 3, 4, 5];
const WEEKEND_VALUES = [0, 6];

export interface TaskRecurrencePayload {
  kind: string;
  interval: number;
  byWeekday?: number[];
  byMonthday?: number[];
  timezone: string;
  until?: string | null;
  rollover: boolean;
  cycleWeekdays?: number[] | null;
  cycleMonthdays?: number[] | null;
}

export interface TaskFormPayload {
  title: string;
  notes?: string;
  type: string;
  priority: string;
  dueDate?: string | null;
  // Task-level time/points (src/lib/taskPoints.ts "base").
  estimatedMinutes?: number | null;
  points?: number | null;
  pointsFollowTime: boolean;
  categoryId?: string | null;
  assigneeId?: string | null;
  // Rotating assignees in turn order; [] clears (src/lib/taskRotation.ts).
  rotationUserIds: string[];
  // object when recurring, null to clear, undefined to leave unchanged
  recurrence?: TaskRecurrencePayload | null;
  // The whole checklist as edited (existing items keep their id).
  subtasks: {
    id?: string;
    title: string;
    done: boolean;
    resetIntervalDays: number | null;
    minutes: number;
    points: number;
    minutesCustom: boolean;
    pointsFollowTime: boolean;
  }[];
}

function parseList(value: string | null): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

// Split an ISO timestamp into local date / time strings for the inputs.
function splitDateTime(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

export function CreateTaskForm({
  categories,
  members,
  initial,
  submitting,
  onSubmit,
  onCancel,
  minutesPerPoint,
}: {
  categories: CategoryDTO[];
  members: MemberDTO[];
  initial?: TaskDTO;
  submitting: boolean;
  onSubmit: (payload: TaskFormPayload) => void;
  onCancel: () => void;
  /** Household rate (points settings), for live points. */
  minutesPerPoint: number;
}) {
  const isEdit = !!initial;
  const initialDue = splitDateTime(initial?.dueDate ?? null);
  const initialUntil = splitDateTime(initial?.recurrence?.until ?? null);

  const [title, setTitle] = useState(initial?.title ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [type, setType] = useState(initial?.type ?? 'one_time');
  const [priority, setPriority] = useState(initial?.priority ?? 'medium');
  const [dueDate, setDueDate] = useState(initialDue.date);
  const [dueTime, setDueTime] = useState(initialDue.time);
  const [points, setPoints] = useState<PointsDraft>(() => draftFromTask(initial));
  const [categoryId, setCategoryId] = useState(initial?.category?.id ?? '');
  const [assigneeId, setAssigneeId] = useState(initial?.assignee?.id ?? '');
  const [rotation, setRotation] = useState<string[]>(
    () => initial?.rotation?.map((m) => m.id) ?? [],
  );
  const [recurKind, setRecurKind] = useState(initial?.recurrence?.kind ?? 'weekly');
  const [interval, setInterval] = useState(initial?.recurrence?.interval ?? 1);
  const [weekdays, setWeekdays] = useState<number[]>(
    parseList(initial?.recurrence?.byWeekday ?? null),
  );
  const [monthdays, setMonthdays] = useState<number[]>(
    parseList(initial?.recurrence?.byMonthday ?? null),
  );
  const [until, setUntil] = useState(initialUntil.date);
  const [rollover, setRollover] = useState(initial?.recurrence?.rollover ?? false);
  const [cycleWeekdays, setCycleWeekdays] = useState<number[]>(
    parseList(initial?.recurrence?.cycleWeekdays ?? null),
  );
  const [cycleMonthdays, setCycleMonthdays] = useState<number[]>(
    parseList(initial?.recurrence?.cycleMonthdays ?? null),
  );

  const isRecurring = type === 'recurring';
  // Turns only move on when a recurring task does, so rotation needs it.
  const rotating = isRecurring && rotation.length >= 2;
  const turnMembers = rotating
    ? rotation
        .map((id) => members.find((m) => m.id === id))
        .filter((m): m is MemberDTO => !!m)
    : members;
  const currentTurn = rotating && !rotation.includes(assigneeId) ? rotation[0] : assigneeId;
  // Weekly/monthly cycles need their start days (the server checks too).
  const cycleIncomplete =
    isRecurring &&
    rollover &&
    ((recurKind === 'weekly' && cycleWeekdays.length === 0) ||
      (recurKind === 'monthly' && cycleMonthdays.length === 0));

  function toggleIn(list: number[], value: number): number[] {
    return list.includes(value)
      ? list.filter((d) => d !== value)
      : [...list, value];
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (cycleIncomplete) return;
    const payload: TaskFormPayload = {
      title: title.trim(),
      type,
      priority,
      notes: notes.trim() || undefined,
      dueDate: dueDate
        ? new Date(`${dueDate}T${dueTime || '12:00'}:00`).toISOString()
        : null,
      estimatedMinutes: points.task.baseMinutes || null,
      points: points.task.pointsFollowTime || points.task.basePointsCenti === null ? null : points.task.basePointsCenti / 100,
      pointsFollowTime: points.task.pointsFollowTime,
      categoryId: categoryId || null,
      assigneeId: currentTurn || null,
      rotationUserIds: rotating ? rotation : [],
      subtasks: points.steps
        .filter((s) => s.title.trim())
        .map((s) => ({
          id: s.id,
          title: s.title.trim(),
          done: false,
          resetIntervalDays: s.resetIntervalDays,
          minutes: s.minutes,
          points: s.pointsCenti / 100,
          minutesCustom: s.minutesCustom,
          pointsFollowTime: s.pointsFollowTime,
        })),
    };

    if (isRecurring) {
      payload.recurrence = {
        kind: recurKind,
        interval: Math.max(1, interval),
        timezone: 'UTC',
        until: until ? new Date(`${until}T12:00:00`).toISOString() : null,
        ...(recurKind === 'weekly' && weekdays.length > 0
          ? { byWeekday: weekdays }
          : {}),
        ...(recurKind === 'monthly' && monthdays.length > 0
          ? { byMonthday: monthdays }
          : {}),
        rollover,
        cycleWeekdays: recurKind === 'weekly' && rollover ? cycleWeekdays : null,
        cycleMonthdays: recurKind === 'monthly' && rollover ? cycleMonthdays : null,
      };
    } else {
      // null clears recurrence on edit; ignored on create.
      payload.recurrence = null;
    }

    onSubmit(payload);
  }

  return (
    <Card>
      <CardContent className="p-5">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              required
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Take the trash out"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional details…"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="type">Type</Label>
              <Select
                id="type"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                {TASK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TASK_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <Select
                id="priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dueDate">Due date</Label>
              <Input
                id="dueDate"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dueTime">Due time</Label>
              <Input
                id="dueTime"
                type="time"
                value={dueTime}
                disabled={!dueDate}
                onChange={(e) => setDueTime(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="assignee">{rotating ? 'Whose turn now' : 'Assignee'}</Label>
              <Select
                id="assignee"
                value={currentTurn}
                onChange={(e) => setAssigneeId(e.target.value)}
              >
                {rotating ? null : <option value="">Unassigned</option>}
                {turnMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select
                id="category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {isRecurring ? (
            <div className="space-y-4 rounded-md border border-border bg-muted/40 p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="recurKind">Repeats</Label>
                  <Select
                    id="recurKind"
                    value={recurKind}
                    onChange={(e) => setRecurKind(e.target.value)}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="interval">Every N days</option>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="interval">
                    {recurKind === 'weekly'
                      ? 'Every N weeks'
                      : recurKind === 'monthly'
                        ? 'Every N months'
                        : 'Interval (days)'}
                  </Label>
                  <Input
                    id="interval"
                    type="number"
                    min={1}
                    max={365}
                    value={interval}
                    onChange={(e) => setInterval(Number(e.target.value))}
                  />
                </div>
              </div>

              {recurKind === 'weekly' ? (
                <div className="space-y-2">
                  <Label>On days (optional)</Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {WEEKDAYS.map((label, day) => (
                      <button
                        key={day}
                        type="button"
                        onClick={() => setWeekdays((p) => toggleIn(p, day))}
                        className={cn(
                          'size-9 rounded-md border text-sm font-medium transition-colors',
                          weekdays.includes(day)
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input hover:bg-accent',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                    <span className="mx-1 text-muted-foreground">·</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setWeekdays(WEEKDAY_VALUES)}
                    >
                      Weekdays
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setWeekdays(WEEKEND_VALUES)}
                    >
                      Weekend
                    </Button>
                  </div>
                </div>
              ) : null}

              {recurKind === 'monthly' ? (
                <div className="space-y-2">
                  <Label>On days of month (optional)</Label>
                  <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-10">
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                      <button
                        key={day}
                        type="button"
                        onClick={() => setMonthdays((p) => toggleIn(p, day))}
                        className={cn(
                          'size-8 rounded-md border text-xs font-medium transition-colors',
                          monthdays.includes(day)
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input hover:bg-accent',
                        )}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="space-y-2 sm:max-w-xs">
                <Label htmlFor="until">Ends on (optional)</Label>
                <Input
                  id="until"
                  type="date"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </div>

              <div className="space-y-2 border-t border-border pt-4">
                <Label>Take turns (optional)</Label>
                <p className="text-xs text-muted-foreground">
                  Pick people in turn order. Each time the task is done
                  {rollover ? ' or its cycle ends (even if missed)' : ''}, it passes to the next person.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {members.map((m) => {
                    const turn = rotation.indexOf(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={turn >= 0}
                        onClick={() =>
                          setRotation((p) =>
                            p.includes(m.id) ? p.filter((id) => id !== m.id) : [...p, m.id],
                          )
                        }
                        className={cn(
                          'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors',
                          turn >= 0
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input hover:bg-accent',
                        )}
                      >
                        {turn >= 0 ? (
                          <span className="text-xs font-semibold tabular-nums">{turn + 1}</span>
                        ) : null}
                        {m.name}
                      </button>
                    );
                  })}
                </div>
                {rotation.length === 1 ? (
                  <p className="text-xs text-muted-foreground">Pick at least two people to take turns.</p>
                ) : null}
                {rotation.length > 0 ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRotation([])}>
                    Clear turns
                  </Button>
                ) : null}
              </div>

              <div className="space-y-2 border-t border-border pt-4">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={rollover}
                    onChange={(e) => setRollover(e.target.checked)}
                  />
                  <span>
                    Runs in cycles
                    <span className="block text-xs text-muted-foreground">
                      Each cycle is a window with the due date inside it. If it isn&apos;t done when the
                      next cycle starts, it&apos;s recorded as missed, checked steps reset and their
                      queued points are dropped. Done early, it waits for the next cycle.
                    </span>
                  </span>
                </label>
                {rollover && recurKind === 'weekly' ? (
                  <div className="space-y-2">
                    <Label>A new cycle starts on</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {WEEKDAYS.map((label, day) => (
                        <button
                          key={day}
                          type="button"
                          onClick={() => setCycleWeekdays((p) => toggleIn(p, day))}
                          className={cn(
                            'size-9 rounded-md border text-sm font-medium transition-colors',
                            cycleWeekdays.includes(day)
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-input hover:bg-accent',
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {rollover && recurKind === 'monthly' ? (
                  <div className="space-y-2">
                    <Label>A new cycle starts on day</Label>
                    <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-10">
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                        <button
                          key={day}
                          type="button"
                          onClick={() => setCycleMonthdays((p) => toggleIn(p, day))}
                          className={cn(
                            'size-8 rounded-md border text-xs font-medium transition-colors',
                            cycleMonthdays.includes(day)
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-input hover:bg-accent',
                          )}
                        >
                          {day}
                        </button>
                      ))}
                    </div>
                    {cycleMonthdays.some((d) => d > 28) ? (
                      <p className="text-xs text-muted-foreground">
                        In months without that day, the cycle starts on the month&apos;s last day.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {rollover && (recurKind === 'daily' || recurKind === 'interval') ? (
                  <p className="text-xs text-muted-foreground">
                    {recurKind === 'daily' && interval <= 1
                      ? 'A new cycle starts every midnight.'
                      : `A new cycle starts every ${Math.max(1, interval)} days at midnight.`}
                  </p>
                ) : null}
                {cycleIncomplete ? (
                  <p className="text-xs text-destructive">Pick when each cycle starts.</p>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="space-y-2 rounded-md border border-border p-4">
            <PointsEditor value={points} onChange={setPoints} minutesPerPoint={minutesPerPoint} />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !title.trim() || cycleIncomplete}>
              {submitting ? <Loader2 className="animate-spin" /> : null}
              {isEdit ? 'Save changes' : 'Add task'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
