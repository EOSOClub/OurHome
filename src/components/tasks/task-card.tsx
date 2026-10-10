'use client';

import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  Repeat,
  Star,
  Trash2,
  Users,
} from 'lucide-react';
import type { TaskDTO } from '@/lib/types';
import { formatPoints, toCenti } from '@/lib/taskPoints';
import { canModify, type PageAccess } from '@/lib/permissions';
import { TASK_TYPE_LABELS, type TaskType } from '@/lib/enums';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CompletionHistory } from '@/components/tasks/completion-history';
import { SubtaskRow } from '@/components/tasks/subtask-row';
import { formatDueDate, isOverdue } from '@/lib/format';
import { useHouseholdZone } from '@/components/household-zone';

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
  onToggleSubtask,
  onAddSubtask,
  onDeleteSubtask,
  onEditSubtask,
  onMoveSubtask,
  onUndoCompletion,
  completing,
  deleting,
  focused = false,
}: {
  task: TaskDTO;
  /** The viewer's Tasks access; own = tasks they created. */
  access: PageAccess;
  userId: string;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (task: TaskDTO) => void;
  onToggleSubtask: (subtaskId: string, done: boolean) => void;
  onAddSubtask: (taskId: string, title: string) => void;
  onDeleteSubtask: (subtaskId: string) => void;
  onEditSubtask: (
    subtaskId: string,
    patch: { title: string; resetIntervalDays: number | null },
  ) => void;
  onMoveSubtask: (task: TaskDTO, subtaskId: string, direction: -1 | 1) => void;
  onUndoCompletion: (completionId: string) => void;
  completing: boolean;
  deleting: boolean;
  /** Opened from a link to this task (?task=<id>, e.g. a notification). */
  focused?: boolean;
}) {
  const timeZone = useHouseholdZone();
  const done = task.status === 'completed';
  // A cycle task completed inside its window waits for the next cycle.
  const doneThisCycle = done && !!task.cycleEndsAt;
  const canEdit = canModify(access, 'edit', task.createdById, userId);
  const canDelete = canModify(access, 'delete', task.createdById, userId);
  const [expanded, setExpanded] = useState(focused);
  useEffect(() => {
    if (focused) document.getElementById(`task-${task.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused, task.id]);
  const [subtaskDraft, setSubtaskDraft] = useState('');

  const doneCount = task.subtasks.filter((s) => s.done).length;
  const hasChecklist = task.subtasks.length > 0;

  function submitSubtask() {
    const t = subtaskDraft.trim();
    if (!t) return;
    onAddSubtask(task.id, t);
    setSubtaskDraft('');
  }

  return (
    <Card
      id={`task-${task.id}`}
      className={cn('flex flex-col gap-3 p-4', focused && 'ring-2 ring-primary')}
    >
      <div className="flex items-start gap-3">
        <Button
          variant={done ? 'secondary' : 'outline'}
          size="icon"
          className="size-9 shrink-0 rounded-full"
          onClick={() => onComplete(task.id)}
          disabled={completing || done}
          aria-label={done ? 'Completed' : 'Mark complete'}
        >
          {completing ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Check className={done ? 'opacity-100' : 'opacity-40'} />
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
                {task.priority}
              </Badge>
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
            {doneThisCycle ? (
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                Done this cycle · reopens {formatUntil(task.cycleEndsAt!, timeZone)}
              </span>
            ) : (
              <span
                className={
                  isOverdue(task.dueDate, timeZone) && !done
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                }
              >
                {formatDueDate(task.dueDate, timeZone)}
              </span>
            )}
            {task.points > 0 ? (
              <span
                className="inline-flex items-center gap-1 text-muted-foreground"
                title="Points are paid when the task is completed"
              >
                <Star className="size-3" />
                {formatPoints(toCenti(task.points))} pts
              </span>
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
        </div>
      </div>

      {expanded ? (
        <div className="ml-12 space-y-3 border-t border-border pt-3">
          <div className="space-y-1.5">
            {task.subtasks.map((s, i) => (
              <SubtaskRow
                key={s.id}
                subtask={s}
                canWrite={canEdit}
                isFirst={i === 0}
                isLast={i === task.subtasks.length - 1}
                onToggle={onToggleSubtask}
                onDelete={onDeleteSubtask}
                onSave={onEditSubtask}
                onMove={(id, dir) => onMoveSubtask(task, id, dir)}
              />
            ))}
            {canEdit ? (
              <div className="flex gap-2">
                <Input
                  value={subtaskDraft}
                  onChange={(e) => setSubtaskDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitSubtask();
                    }
                  }}
                  placeholder="Add a checklist item…"
                  className="h-9"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={submitSubtask}
                  aria-label="Add checklist item"
                >
                  <Plus />
                </Button>
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
