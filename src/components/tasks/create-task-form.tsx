'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Plus, X } from 'lucide-react';
import type { CategoryDTO, MemberDTO, SubtaskDTO, TaskDTO } from '@/lib/types';
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
import { SubtaskRow } from '@/components/tasks/subtask-row';

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
}

export interface TaskFormPayload {
  title: string;
  notes?: string;
  type: string;
  priority: string;
  dueDate?: string | null;
  estimatedMinutes?: number | null;
  categoryId?: string | null;
  assigneeId?: string | null;
  // object when recurring, null to clear, undefined to leave unchanged
  recurrence?: TaskRecurrencePayload | null;
  // create mode only: initial checklist
  subtasks?: { title: string; done: boolean }[];
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
  checklist,
}: {
  categories: CategoryDTO[];
  members: MemberDTO[];
  initial?: TaskDTO;
  submitting: boolean;
  onSubmit: (payload: TaskFormPayload) => void;
  onCancel: () => void;
  /**
   * Edit mode only: live checklist management. Items already exist on the
   * server, so these actions apply immediately (independent of Save/Cancel).
   */
  checklist?: {
    subtasks: SubtaskDTO[];
    onAdd: (title: string) => void;
    onToggle: (subtaskId: string, done: boolean) => void;
    onSave: (
      subtaskId: string,
      patch: { title: string; resetIntervalDays: number | null },
    ) => void;
    onDelete: (subtaskId: string) => void;
    onMove: (subtaskId: string, direction: -1 | 1) => void;
  };
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
  const [estimatedMinutes, setEstimatedMinutes] = useState(
    initial?.estimatedMinutes != null ? String(initial.estimatedMinutes) : '',
  );
  const [categoryId, setCategoryId] = useState(initial?.category?.id ?? '');
  const [assigneeId, setAssigneeId] = useState(initial?.assignee?.id ?? '');
  const [recurKind, setRecurKind] = useState(initial?.recurrence?.kind ?? 'weekly');
  const [interval, setInterval] = useState(initial?.recurrence?.interval ?? 1);
  const [weekdays, setWeekdays] = useState<number[]>(
    parseList(initial?.recurrence?.byWeekday ?? null),
  );
  const [monthdays, setMonthdays] = useState<number[]>(
    parseList(initial?.recurrence?.byMonthday ?? null),
  );
  const [until, setUntil] = useState(initialUntil.date);
  const [subtasks, setSubtasks] = useState<string[]>([]);
  const [subtaskDraft, setSubtaskDraft] = useState('');

  const isRecurring = type === 'recurring';

  function toggleIn(list: number[], value: number): number[] {
    return list.includes(value)
      ? list.filter((d) => d !== value)
      : [...list, value];
  }

  function addSubtaskDraft() {
    const t = subtaskDraft.trim();
    if (!t) return;
    setSubtasks((prev) => [...prev, t]);
    setSubtaskDraft('');
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: TaskFormPayload = {
      title: title.trim(),
      type,
      priority,
      notes: notes.trim() || undefined,
      dueDate: dueDate
        ? new Date(`${dueDate}T${dueTime || '12:00'}:00`).toISOString()
        : null,
      estimatedMinutes: estimatedMinutes ? Number(estimatedMinutes) : null,
      categoryId: categoryId || null,
      assigneeId: assigneeId || null,
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
      };
    } else {
      // null clears recurrence on edit; ignored on create.
      payload.recurrence = null;
    }

    if (!isEdit && subtasks.length > 0) {
      payload.subtasks = subtasks.map((t) => ({ title: t, done: false }));
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
              <Label htmlFor="estimate">Estimated effort (min)</Label>
              <Input
                id="estimate"
                type="number"
                min={1}
                value={estimatedMinutes}
                onChange={(e) => setEstimatedMinutes(e.target.value)}
                placeholder="e.g. 15"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="assignee">Assignee</Label>
              <Select
                id="assignee"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
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
            </div>
          ) : null}

          {isEdit && checklist ? (
            <div className="space-y-2">
              <Label>Checklist</Label>
              <div className="space-y-1.5">
                {checklist.subtasks.map((s, i) => (
                  <SubtaskRow
                    key={s.id}
                    subtask={s}
                    canWrite
                    isFirst={i === 0}
                    isLast={i === checklist.subtasks.length - 1}
                    onToggle={checklist.onToggle}
                    onDelete={checklist.onDelete}
                    onSave={checklist.onSave}
                    onMove={checklist.onMove}
                  />
                ))}
                <ChecklistQuickAdd onAdd={checklist.onAdd} />
              </div>
              <p className="text-xs text-muted-foreground">
                Checklist changes save immediately.
              </p>
            </div>
          ) : null}

          {!isEdit ? (
            <div className="space-y-2">
              <Label>Checklist (optional)</Label>
              {subtasks.length > 0 ? (
                <ul className="space-y-1">
                  {subtasks.map((t, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate">{t}</span>
                      <button
                        type="button"
                        aria-label="Move item up"
                        disabled={i === 0}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        onClick={() =>
                          setSubtasks((prev) => {
                            const next = [...prev];
                            [next[i - 1], next[i]] = [next[i], next[i - 1]];
                            return next;
                          })
                        }
                      >
                        <ChevronUp className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="Move item down"
                        disabled={i === subtasks.length - 1}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        onClick={() =>
                          setSubtasks((prev) => {
                            const next = [...prev];
                            [next[i], next[i + 1]] = [next[i + 1], next[i]];
                            return next;
                          })
                        }
                      >
                        <ChevronDown className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="Remove item"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          setSubtasks((prev) => prev.filter((_, idx) => idx !== i))
                        }
                      >
                        <X className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex gap-2">
                <Input
                  value={subtaskDraft}
                  onChange={(e) => setSubtaskDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addSubtaskDraft();
                    }
                  }}
                  placeholder="Add a checklist item…"
                />
                <Button type="button" variant="outline" onClick={addSubtaskDraft}>
                  <Plus />
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting ? <Loader2 className="animate-spin" /> : null}
              {isEdit ? 'Save changes' : 'Add task'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// Quick-add input for the edit-mode checklist; adds apply to the server
// immediately via the parent's mutation.
function ChecklistQuickAdd({ onAdd }: { onAdd: (title: string) => void }) {
  const [draft, setDraft] = useState('');

  function submit() {
    const t = draft.trim();
    if (!t) return;
    onAdd(t);
    setDraft('');
  }

  return (
    <div className="flex gap-2">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Add a checklist item…"
        className="h-9"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={submit}
        aria-label="Add checklist item"
      >
        <Plus />
      </Button>
    </div>
  );
}
