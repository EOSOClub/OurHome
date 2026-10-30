'use client';

import { useEffect, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Hourglass,
  ListChecks,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Repeat,
  Star,
  Trash2,
  Users,
} from 'lucide-react';
import type { TaskDTO } from '@/lib/types';
import { formatPoints, toCenti } from '@/lib/taskPoints';
import { plusPoints } from '@/lib/taskChecks';
import { placesLabel } from '@/lib/places';
import { canModify, type PageAccess } from '@/lib/permissions';
import { PRIORITY_LABELS, TASK_TYPE_LABELS, type TaskPriority, type TaskType } from '@/lib/enums';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldNote } from '@/components/ui/field-note';
import { fieldErrors } from '@/lib/api';
import { CompletionHistory } from '@/components/tasks/completion-history';
import { SubtaskRow } from '@/components/tasks/subtask-row';
import { formatDueDate, isOverdue } from '@/lib/format';
import { useHouseholdZone } from '@/components/household-zone';
import { usePointsShown } from '@/components/household-features';

function priorityVariant(
  priority: string,
): 'default' | 'secondary' | 'destructive' | 'warning' {
  switch (priority) {
    case 'urgent':
      return 'destructive';
    case 'high':
      return 'warning';
    case 'low':
      return 'secondary';
    default:
      return 'default';
  }
}

function formatEffort(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function TaskCard({
  task,
  access,
  userId,
  onComplete,
  onDelete,
  onEdit,
  onArchive,
  onToggleSubtask,
  onAddSubtask,
  onDeleteSubtask,
  onEditSubtask,
  onMoveSubtask,
  onUndoCompletion,
  completing,
  deleting,
  focused = false,
  move,
  hidePlace = false,
  isHead = false,
  onTakeBack,
  takingBackId = null,
}: {
  task: TaskDTO;
  /** The viewer's Tasks access; own = tasks they created. */
  access: PageAccess;
  userId: string;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (task: TaskDTO) => void;
  /** Park the task out of the active list (true) or bring it back (false). */
  onArchive: (taskId: string, archived: boolean) => void;
  onToggleSubtask: (subtaskId: string, done: boolean) => void;
  /** Resolves once saved; rejects when refused (the draft stays, marked). */
  onAddSubtask: (taskId: string, title: string) => Promise<unknown>;
  onDeleteSubtask: (subtaskId: string) => void;
  /** Resolves once saved; rejects when refused (the row stays in edit, marked). */
  onEditSubtask: (
    subtaskId: string,
    patch: { title: string; resetIntervalDays: number | null },
  ) => Promise<unknown>;
  onMoveSubtask: (task: TaskDTO, subtaskId: string, direction: -1 | 1) => void;
  onUndoCompletion: (completionId: string) => void;
  completing: boolean;
  deleting: boolean;
  /** Opened from a link to this task (?task=<id>, e.g., a notification). */
  focused?: boolean;
  /** Up/down within its place (grouped by room, for those who may reorder). */
  move?: { up: boolean; down: boolean; onMove: (direction: -1 | 1) => void };
  /** Under a room heading, the place label would only repeat it. */
  hidePlace?: boolean;
  /** The viewer is the Head of House (not a reviewer unless they look after the child). */
  isHead?: boolean;
  /** Take back the viewer's own waiting check (POST /api/tasks/submissions/withdraw). */
  onTakeBack?: (submissionId: string) => void;
  /** The check being taken back right now, if any. */
  takingBackId?: string | null;
}) {
  const timeZone = useHouseholdZone();
  const showPoints = usePointsShown();
  const done = task.status === 'completed';
  const archived = task.status === 'archived';
  // A cycle task completed inside its window waits for the next cycle.
  const doneThisCycle = done && !!task.cycleEndsAt;
  // A repeating task without cycles, done for this occurrence: the next one
  // can't be completed before it opens. The clock moves on when it does, so
  // the button comes back at midnight without a refresh.
  const [now, setNow] = useState(() => Date.now());
  const opensAt = task.opensAt ? Date.parse(task.opensAt) : 0;
  const waiting = !done && !archived && opensAt > now;
  useEffect(() => {
    if (!waiting) return;
    // setTimeout holds at most ~24 days; a longer wait just checks again then.
    const t = setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, opensAt - Date.now()), 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [waiting, opensAt, now]);
  const canEdit = canModify(access, 'edit', task.createdById, userId);
  const canDelete = canModify(access, 'delete', task.createdById, userId);
  const [expanded, setExpanded] = useState(focused);
  useEffect(() => {
    if (focused) document.getElementById(`task-${task.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused, task.id]);
  const [subtaskDraft, setSubtaskDraft] = useState('');
  // Why the server refused the draft (the global toast says it too); cleared on typing.
  const [subtaskError, setSubtaskError] = useState<string | null>(null);

  const doneCount = task.subtasks.filter((s) => s.done).length;
  const hasChecklist = task.subtasks.length > 0;

  // Sent for a check (Task Photo Proof): it waits for an adult's OK.
  const waitingCheck = task.review.waiting;
  const sentByMe = waitingCheck && task.review.submittedBy?.id === userId;
  // The check's id comes only to the child who sent it and the adults who look after them.
  const checkId = task.review.submissionId;
  // The head decides only for children they look after: say how to.
  const headHint = isHead && waitingCheck && !sentByMe && !checkId;
  const takingBack = !!checkId && takingBackId === checkId;

  async function submitSubtask() {
    const t = subtaskDraft.trim();
    if (!t) return;
    setSubtaskError(null);
    try {
      await onAddSubtask(task.id, t);
      // Only once it's added, so a refused title stays to fix.
      setSubtaskDraft('');
    } catch (err) {
      setSubtaskError(fieldErrors(err).title ?? (err instanceof Error ? err.message : 'Could not add it.'));
    }
  }

  return (
    <Card
      id={`task-${task.id}`}
      className={cn('flex flex-col gap-3 p-4', focused && 'ring-2 ring-primary')}
    >
      <div className="flex items-start gap-3">
        <Button
          variant={done || waiting || waitingCheck ? 'secondary' : 'outline'}
          size="icon"
          className="size-9 shrink-0 rounded-full"
          onClick={() => onComplete(task.id)}
          // The server refuses to complete an archived task; restore it first.
          // One waiting for an OK can't be completed until it's decided.
          disabled={completing || done || archived || waiting || waitingCheck}
          aria-label={
            done
              ? 'Completed'
              : archived
                ? 'Archived'
                : waitingCheck
                  ? 'Waiting for an OK'
                  : waiting
                    ? 'Done for now'
                    : 'Mark complete'
          }
        >
          {completing ? (
            <Loader2 className="animate-spin" />
          ) : waitingCheck ? (
            <Hourglass />
          ) : (
            <Check className={done || waiting ? 'opacity-100' : 'opacity-40'} />
          )}
        </Button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p
              className={cn(
                'font-medium leading-snug',
                done && !doneThisCycle && 'text-muted-foreground line-through',
              )}
            >
              {task.category?.color ? (
                <span
                  className="mr-2 inline-block size-2.5 rounded-full align-middle"
                  style={{ backgroundColor: task.category.color }}
                />
              ) : null}
              {task.title}
            </p>
            <div className="flex shrink-0 items-center gap-1">
              <Badge variant={priorityVariant(task.priority)}>
                {PRIORITY_LABELS[task.priority as TaskPriority] ?? task.priority}
              </Badge>
              {move ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-foreground"
                    onClick={() => move.onMove(-1)}
                    disabled={!move.up}
                    aria-label="Move up"
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-foreground"
                    onClick={() => move.onMove(1)}
                    disabled={!move.down}
                    aria-label="Move down"
                  >
                    <ArrowDown />
                  </Button>
                </>
              ) : null}
              {canEdit ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-foreground"
                  onClick={() => onEdit(task)}
                  aria-label="Edit task"
                >
                  <Pencil />
                </Button>
              ) : null}
              {/* Archiving is a status change, refused while it waits for an OK. */}
              {canEdit && (archived || !done) && !waitingCheck ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-foreground"
                  onClick={() => onArchive(task.id, !archived)}
                  aria-label={archived ? 'Restore task' : 'Archive task'}
                  title={archived ? 'Restore task' : 'Archive task'}
                >
                  {archived ? <ArchiveRestore /> : <Archive />}
                </Button>
              ) : null}
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(task.id)}
                  disabled={deleting}
                  aria-label="Delete task"
                >
                  {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                </Button>
              ) : null}
            </div>
          </div>

          {task.notes ? (
            <p className="mt-1 text-sm text-muted-foreground">{task.notes}</p>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {waitingCheck ? (
              sentByMe ? (
                <span className="inline-flex items-center gap-2">
                  <span className="font-medium text-amber-700 dark:text-amber-400">Waiting for an OK</span>
                  {onTakeBack ? (
                    <button
                      type="button"
                      onClick={() => checkId && onTakeBack(checkId)}
                      disabled={!checkId || takingBack}
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50"
                    >
                      {takingBack ? <Loader2 className="size-3 animate-spin" /> : null}
                      Take back
                    </button>
                  ) : null}
                </span>
              ) : (
                <span className="font-medium text-amber-700 dark:text-amber-400">
                  {task.review.submittedBy?.name ?? 'Someone'} sent this for a check
                </span>
              )
            ) : null}
            {doneThisCycle ? (
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                Done this cycle · reopens {formatUntil(task.cycleEndsAt!, timeZone)}
              </span>
            ) : (
              <>
                {waiting ? (
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">
                    Done · next opens {formatUntil(task.opensAt!, timeZone)}
                  </span>
                ) : null}
                <span
                  className={
                    isOverdue(task.dueDate, timeZone) && !done
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  }
                >
                  {formatDueDate(task.dueDate, timeZone)}
                </span>
              </>
            )}
            {/* Grouped by room, the heading already says where. */}
            {!hidePlace && placesLabel(task) ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <MapPin className="size-3" />
                {placesLabel(task)}
              </span>
            ) : null}
            {showPoints && task.points > 0 ? (
              sentByMe ? (
                <span
                  className="inline-flex items-center gap-1 text-muted-foreground"
                  title="Points are paid when an adult approves it"
                >
                  <Star className="size-3" />
                  {plusPoints(task.points)} waiting for an OK
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-muted-foreground"
                  title="Points are paid when the task is completed"
                >
                  <Star className="size-3" />
                  {formatPoints(toCenti(task.points))} pts
                </span>
              )
            ) : null}
            {task.assignee ? (
              <span className="text-muted-foreground">
                · {task.assignee.name}
                {task.rotation?.length ? '’s turn' : ''}
              </span>
            ) : null}
            {task.nextAssignee ? (
              <span
                className="inline-flex items-center gap-1 text-muted-foreground"
                title={`Takes turns: ${task.rotation.map((m) => m.name).join(' → ')}`}
              >
                <Users className="size-3" />
                next {task.nextAssignee.name}
              </span>
            ) : null}
            {task.estimatedMinutes ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Clock className="size-3" />
                {formatEffort(task.estimatedMinutes)}
              </span>
            ) : null}
            {task.recurrence ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Repeat className="size-3" />
                {recurrenceLabel(task.recurrence)}
              </span>
            ) : (
              <Badge variant="outline">
                {TASK_TYPE_LABELS[task.type as TaskType] ?? task.type}
              </Badge>
            )}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              <ListChecks className="size-3" />
              {hasChecklist ? `${doneCount}/${task.subtasks.length}` : 'Details'}
              {expanded ? (
                <ChevronUp className="size-3" />
              ) : (
                <ChevronDown className="size-3" />
              )}
            </button>
          </div>
          {headHint ? (
            <p className="mt-1 text-xs text-muted-foreground">
              To check it yourself, add yourself as someone who looks after{' '}
              {task.review.submittedBy?.name ?? 'them'} on the Members page.
            </p>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="ml-12 space-y-3 border-t border-border pt-3">
          <div className="space-y-1.5">
            {task.subtasks.map((s, i) => (
              <SubtaskRow
                key={s.id}
                subtask={s}
                // While it waits, only the name of a step may change, and not by the one who sent it.
                canWrite={canEdit && !sentByMe}
                locked={waitingCheck}
                waitingForOk={s.waitingForOk}
                isFirst={i === 0}
                isLast={i === task.subtasks.length - 1}
                onToggle={onToggleSubtask}
                onDelete={onDeleteSubtask}
                onSave={onEditSubtask}
                onMove={(id, dir) => onMoveSubtask(task, id, dir)}
              />
            ))}
            {/* Adding a step to a task waiting for an OK is refused. */}
            {canEdit && !waitingCheck ? (
              <div className="space-y-1">
                <div className="flex gap-2">
                  <Input
                    value={subtaskDraft}
                    onChange={(e) => {
                      setSubtaskDraft(e.target.value);
                      setSubtaskError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void submitSubtask();
                      }
                    }}
                    placeholder="Add a checklist item…"
                    aria-label="New checklist item"
                    aria-invalid={subtaskError ? true : undefined}
                    aria-describedby={`task-${task.id}-new-step-note`}
                    className="h-9"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void submitSubtask()}
                    aria-label="Add checklist item"
                  >
                    <Plus />
                  </Button>
                </div>
                <FieldNote id={`task-${task.id}-new-step-note`} error={subtaskError} />
              </div>
            ) : null}
          </div>

          <CompletionHistory taskId={task.id} onUndo={onUndoCompletion} />
        </div>
      ) : null}
    </Card>
  );
}


function recurrenceLabel(r: NonNullable<TaskDTO['recurrence']>): string {
  const base = baseRecurrenceLabel(r);
  return r.until ? `${base}, ends ${formatUntil(r.until)}` : base;
}

function baseRecurrenceLabel(r: NonNullable<TaskDTO['recurrence']>): string {
  const every = r.interval > 1 ? `every ${r.interval} ` : '';
  switch (r.kind) {
    case 'daily':
      return r.interval > 1 ? `${every}days` : 'daily';
    case 'weekly':
      return r.interval > 1 ? `${every}weeks` : 'weekly';
    case 'monthly':
      return r.interval > 1 ? `${every}months` : 'monthly';
    case 'yearly':
      return r.interval > 1 ? `${every}years` : 'yearly';
    case 'interval':
      return `every ${r.interval} days`;
    case 'cron':
      return 'custom';
    default:
      return r.kind;
  }
}

function formatUntil(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    timeZone,
    month: 'short',
    day: 'numeric',
  });
}
