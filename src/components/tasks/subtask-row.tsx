'use client';

import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Pencil, Repeat, X } from 'lucide-react';
import type { SubtaskDTO } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';

/**
 * One checklist item — shared by the task card's expanded checklist and the
 * task editor. Handles its own inline edit mode (title + reset cadence) and
 * delete confirmation; toggling/reordering/saving go through the caller's
 * mutations.
 */

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
}: {
  subtask: SubtaskDTO;
  canWrite: boolean;
  isFirst: boolean;
  isLast: boolean;
  onToggle: (subtaskId: string, done: boolean) => void;
  onDelete: (subtaskId: string) => void;
  onSave: (
    subtaskId: string,
    patch: { title: string; resetIntervalDays: number | null },
  ) => void;
  onMove: (subtaskId: string, direction: -1 | 1) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(subtask.title);
  const [resetDraft, setResetDraft] = useState(
    subtask.resetIntervalDays?.toString() ?? '',
  );

  function startEdit() {
    setTitleDraft(subtask.title);
    setResetDraft(subtask.resetIntervalDays?.toString() ?? '');
    setEditing(true);
  }

  function save() {
    const title = titleDraft.trim();
    if (!title) return;
    const parsed = parseInt(resetDraft, 10);
    const resetIntervalDays =
      Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 365) : null;
    onSave(subtask.id, { title, resetIntervalDays });
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="space-y-1.5 rounded-md border border-border p-2">
        <Input
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          className="h-8 text-sm"
          aria-label="Checklist item title"
          autoFocus
        />
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Resets every
            <Input
              type="number"
              min={1}
              max={365}
              value={resetDraft}
              onChange={(e) => setResetDraft(e.target.value)}
              placeholder="—"
              className="h-7 w-16 text-xs"
              aria-label="Reset interval in days"
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
              onClick={save}
              disabled={!titleDraft.trim()}
            >
              Save
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Leave empty to reset only when the task repeats.
        </p>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2">
      <button
        type="button"
        onClick={() => onToggle(subtask.id, !subtask.done)}
        aria-label={subtask.done ? 'Mark not done' : 'Mark done'}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded border transition-colors',
          subtask.done
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-input hover:bg-accent',
        )}
      >
        {subtask.done ? <Check className="size-3.5" /> : null}
      </button>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          subtask.done && 'text-muted-foreground line-through',
        )}
      >
        {subtask.title}
      </span>
      {subtask.resetIntervalDays ? (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
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
      {canWrite ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label="Move item up"
            disabled={isFirst}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            onClick={() => onMove(subtask.id, -1)}
          >
            <ChevronUp className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Move item down"
            disabled={isLast}
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
            className="text-muted-foreground hover:text-destructive"
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
