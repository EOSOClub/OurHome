'use client';

import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Pencil, Repeat, X } from 'lucide-react';
import type { SubtaskDTO } from '@/lib/types';
import { cn } from '@/lib/utils';
import { formatPoints, toCenti } from '@/lib/taskPoints';
import { usePointsShown } from '@/components/household-features';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { FieldNote } from '@/components/ui/field-note';
import { fieldErrors } from '@/lib/api';

/**
 * One checklist item - shared by the task card's expanded checklist and the
 * task editor. Handles its own inline edit mode (title and reset cadence) and
 * delete confirmation; toggling/reordering/saving go through the caller's
 * mutations.
 */

/** [errs] with [key]'s error dropped (that field was edited). */
function without(errs: Record<string, string>, key: string): Record<string, string> {
  if (!(key in errs)) return errs;
  const next = { ...errs };
  delete next[key];
  return next;
}

function resetBadgeLabel(days: number): string {
  return days === 1 ? 'daily' : `${days}d`;
}

export function SubtaskRow({
  subtask,
  canWrite,
  isFirst,
  isLast,
  onToggle,
  onDelete,
  onSave,
  onMove,
  waitingForOk = false,
  locked = false,
}: {
  subtask: SubtaskDTO;
  canWrite: boolean;
  /** Its points wait for an adult's OK (a "steps" check): shows the chip. */
  waitingForOk?: boolean;
  /** The task waits for an OK: no ticking, moving or removing; only its name may change. */
  locked?: boolean;
  isFirst: boolean;
  isLast: boolean;
  onToggle: (subtaskId: string, done: boolean) => void;
  onDelete: (subtaskId: string) => void;
  /** Resolves once saved; rejects when refused, and the row stays in edit with the field marked. */
  onSave: (
    subtaskId: string,
    patch: { title: string; resetIntervalDays: number | null },
  ) => Promise<unknown>;
  onMove: (subtaskId: string, direction: -1 | 1) => void;
}) {
  const showPoints = usePointsShown();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState(subtask.title);
  const [resetDraft, setResetDraft] = useState(
    subtask.resetIntervalDays?.toString() ?? '',
  );
  // What the server said was wrong with each field (the global toast says it too).
  const [errors, setErrors] = useState<Record<string, string>>({});

  function startEdit() {
    setTitleDraft(subtask.title);
    setResetDraft(subtask.resetIntervalDays?.toString() ?? '');
    setErrors({});
    setEditing(true);
  }

  async function save() {
    const title = titleDraft.trim();
    if (!title || saving) return;
    const parsed = parseInt(resetDraft, 10);
    const resetIntervalDays =
      Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 365) : null;
    setSaving(true);
    setErrors({});
    try {
      await onSave(subtask.id, { title, resetIntervalDays });
      setEditing(false);
    } catch (err) {
      const fields = fieldErrors(err);
      setErrors(Object.keys(fields).length ? fields : { title: err instanceof Error ? err.message : 'Could not save it.' });
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    const noteId = `step-${subtask.id}-note`;
    const error = errors.title ?? errors.resetIntervalDays ?? null;
    return (
      <div className="space-y-1.5 rounded-md border border-border p-2">
        <Input
          value={titleDraft}
          onChange={(e) => {
            setTitleDraft(e.target.value);
            setErrors((errs) => without(errs, 'title'));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          className="h-8 text-sm"
          aria-label="Checklist item title"
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={noteId}
          autoFocus
        />
        {/* Wraps on a narrow card rather than pushing the row wider. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Resets every
            <Input
              type="number"
              min={1}
              max={365}
              value={resetDraft}
              onChange={(e) => {
                setResetDraft(e.target.value);
                setErrors((errs) => without(errs, 'resetIntervalDays'));
              }}
              placeholder="-"
              disabled={locked}
              className="h-7 w-16 text-xs"
              aria-label="Reset interval in days"
              aria-invalid={errors.resetIntervalDays ? true : undefined}
              aria-describedby={noteId}
            />
            days
          </label>
          <div className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7"
              onClick={() => void save()}
              disabled={!titleDraft.trim() || saving}
            >
              Save
            </Button>
          </div>
        </div>
        {error ? (
          <FieldNote id={noteId} error={error} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Leave empty to reset only when the task repeats.
          </p>
        )}
      </div>
    );
  }

  const who = subtask.queuedFor || subtask.doneBy;
  const hasDetails =
    waitingForOk || !!who || (showPoints && subtask.points > 0) || !!subtask.resetIntervalDays;

  return (
    <div className="group flex items-start gap-2">
      <button
        type="button"
        onClick={() => onToggle(subtask.id, !subtask.done)}
        // Ticking a task that waits for an OK is refused; don't flick the box.
        disabled={locked}
        aria-label={subtask.done ? 'Mark not done' : 'Mark done'}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-60',
          subtask.done
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-input hover:bg-accent',
        )}
      >
        {subtask.done ? <Check className="size-3.5" /> : null}
      </button>
      {/* The name keeps a readable width; on a narrow row, what's said about
          the step wraps onto the next line instead of pushing the row wider. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span
          className={cn(
            'min-w-[7rem] flex-1 break-words text-sm',
            subtask.done && 'text-muted-foreground line-through',
          )}
        >
          {subtask.title}
        </span>
        {hasDetails ? (
          <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {waitingForOk ? (
              <span className="whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                Waiting for an OK
              </span>
            ) : null}
            {/* Shows who did it, and whether its points are waiting for the task. */}
            {who ? (
              <span
                className="min-w-0 break-words"
                title={
                  showPoints && subtask.queuedFor
                    ? `${subtask.queuedFor.name}'s points are queued until the task is completed`
                    : undefined
                }
              >
                {showPoints && subtask.queuedFor
                  ? `queued · ${subtask.queuedFor.name}`
                  : (subtask.queuedFor ?? subtask.doneBy)?.name}
              </span>
            ) : null}
            {showPoints && subtask.points > 0 ? (
              <span className="whitespace-nowrap tabular-nums">{formatPoints(toCenti(subtask.points))} pts</span>
            ) : null}
            {subtask.resetIntervalDays ? (
              <span
                className="inline-flex items-center gap-0.5 whitespace-nowrap"
                title={
                  subtask.resetIntervalDays === 1
                    ? 'Unchecks itself every day'
                    : `Unchecks itself every ${subtask.resetIntervalDays} days`
                }
              >
                <Repeat className="size-3" />
                {resetBadgeLabel(subtask.resetIntervalDays)}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {canWrite ? (
        <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
          <button
            type="button"
            aria-label="Move item up"
            disabled={isFirst || locked}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            onClick={() => onMove(subtask.id, -1)}
          >
            <ChevronUp className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Move item down"
            disabled={isLast || locked}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            onClick={() => onMove(subtask.id, 1)}
          >
            <ChevronDown className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Edit item"
            className="text-muted-foreground hover:text-foreground"
            onClick={startEdit}
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Remove item"
            disabled={locked}
            className="text-muted-foreground hover:text-destructive disabled:opacity-30"
            onClick={() => setConfirmDelete(true)}
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete(subtask.id);
        }}
        title="Remove checklist item?"
        description={`Remove "${subtask.title}" from the checklist?`}
        confirmLabel="Remove"
        destructive
      />
    </div>
  );
}
