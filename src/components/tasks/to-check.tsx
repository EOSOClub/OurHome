'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp, Image as ImageIcon, Loader2, Undo2, X } from 'lucide-react';
import type { TaskDTO, TaskSubmissionDTO } from '@/lib/types';
import { ApiError, apiFetch, fieldErrors } from '@/lib/api';
import { checkCode, checkTime, decideByLine, entryLines, plusPoints } from '@/lib/taskChecks';
import { cn } from '@/lib/utils';
import { useHouseholdZone } from '@/components/household-zone';
import { usePointsShown } from '@/components/household-features';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { FieldNote } from '@/components/ui/field-note';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

/** GET /api/tasks/submissions: To check, plus the viewer's own checks. */
export const TASK_SUBMISSIONS_KEY = ['task-submissions'];

type Decided = TaskDTO & { completionId: string | null };
type Undone = TaskDTO & { undo?: 'back_to_check' | 'undone' };

/** A check counted as done when its day ended (3 days to take the points back). */
const isCycleEnd = (s: TaskSubmissionDTO) => s.status === 'auto_approved' && s.autoReason === 'cycle_end';

const photoUrl = (id: string) => `/api/tasks/submissions/photo?id=${encodeURIComponent(id)}`;

/**
 * The decide replies that mean the item moved on: say so plainly and look
 * again. check_decided (someone already decided it, or lost a race), plus the
 * two uncoded 409s: counted as done when its day ended, and past the 3 days.
 */
function movedOn(err: unknown): boolean {
  if (checkCode(err) === 'check_decided') return true;
  return err instanceof ApiError && err.status === 409 && checkCode(err) === null;
}

/**
 * To check, at the top of the Tasks page for an adult who looks after
 * children with checks waiting (Task Photo Proof): each item with Approve /
 * Send back, the row pattern of a request's decision (requests-view
 * DecisionRow). A photo loads only when its item is opened.
 */
export function ToCheck({ items }: { items: TaskSubmissionDTO[] }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const showPoints = usePointsShown();
  const [sendBack, setSendBack] = useState<TaskSubmissionDTO | null>(null);

  function refresh() {
    // The Tasks badge in the nav is counted by the server layout: render it again.
    router.refresh();
    void queryClient.invalidateQueries({ queryKey: TASK_SUBMISSIONS_KEY });
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['points'] });
    void queryClient.invalidateQueries({ queryKey: ['task-completions'] });
  }

  const undo = useMutation({
    mutationFn: (completionId: string) =>
      apiFetch<Undone>('/api/tasks/completions/undo', {
        method: 'POST',
        body: JSON.stringify({ completionId }),
      }),
    onSuccess: (task) => {
      toast.success(
        task.undo === 'back_to_check'
          ? 'Back in To check'
          : showPoints
            ? 'Undone. The points were taken back.'
            : 'Undone.',
      );
    },
    onSettled: refresh,
  });

  const approve = useMutation({
    mutationFn: (item: TaskSubmissionDTO) =>
      apiFetch<Decided>('/api/tasks/submissions/decide', {
        method: 'POST',
        body: JSON.stringify({ submissionId: item.id, decision: 'approve' }),
      }),
    onSuccess: (result, item) => {
      const completionId = result.completionId;
      toast.success(
        `Approved “${item.task.title}” for ${item.child.name}`,
        completionId ? { label: 'Undo', onClick: () => undo.mutate(completionId) } : undefined,
      );
    },
    // A local onError keeps the global toast away; say it here, plainly.
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Something went wrong.'),
    onSettled: refresh,
  });

  if (items.length === 0) return null;
  return (
    <section className="space-y-2" aria-labelledby="to-check-heading">
      <h2 id="to-check-heading" className="text-lg font-semibold">
        To check
      </h2>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <ToCheckRow
              key={item.id}
              item={item}
              busy={approve.isPending && approve.variables?.id === item.id}
              onApprove={() => approve.mutate(item)}
              onSendBack={() => setSendBack(item)}
            />
          ))}
        </ul>
      </Card>
      {sendBack ? (
        <SendBackDialog
          key={sendBack.id}
          item={sendBack}
          onClose={() => setSendBack(null)}
          onDone={() => {
            setSendBack(null);
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function ToCheckRow({
  item,
  busy,
  onApprove,
  onSendBack,
}: {
  item: TaskSubmissionDTO;
  busy: boolean;
  onApprove: () => void;
  onSendBack: () => void;
}) {
  const timeZone = useHouseholdZone();
  const showPoints = usePointsShown();
  const [open, setOpen] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const cycleEnd = isCycleEnd(item);
  const steps = item.kind === 'steps';
  const decides = item.actions.includes('approve');
  // Opening shows the photo and the steps as they were sent.
  const hasDetails = item.kind === 'task' && (item.hasPhoto || item.steps.length > 0);
  const detailsId = useId();

  return (
    <li className={cn('flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start', decides && 'bg-primary/5')}>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="min-w-0 break-words font-medium">
          {item.child.name} · {steps ? `Steps on “${item.task.title}”` : `“${item.task.title}”`}
        </p>
        {cycleEnd ? (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Counted as done when the day ended</p>
        ) : null}
        {steps ? (
          <>
            <ul className="space-y-0.5 text-sm">
              {entryLines(item.entries, timeZone).map((line) => (
                <li key={line.key} className="break-words">
                  {line.text}
                </li>
              ))}
            </ul>
            {showPoints ? <p className="text-xs text-muted-foreground">{plusPoints(item.points)} in all</p> : null}
          </>
        ) : (
          <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span>Sent {checkTime(item.submittedAt, timeZone)}</span>
            {item.steps.length > 0 ? (
              <span>
                · {item.stepsTicked} of {item.steps.length} steps ticked
              </span>
            ) : null}
            {showPoints && item.points > 0 ? <span>· {plusPoints(item.points)}</span> : null}
          </p>
        )}
        {item.note ? <p className="whitespace-pre-line break-words text-sm">{item.note}</p> : null}
        {item.status === 'waiting' && item.decideBy ? (
          <p className="text-xs text-muted-foreground">{decideByLine(item.decideBy, timeZone)}</p>
        ) : null}
        {hasDetails ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailsId}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {item.hasPhoto ? <ImageIcon className="size-3" /> : null}
            {item.hasPhoto ? (item.steps.length > 0 ? 'Photo and steps' : 'Photo') : 'Steps'}
            {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        ) : null}
        {open && hasDetails ? (
          <div id={detailsId} className="space-y-2 pt-1">
            {item.hasPhoto ? (
              // Fixed size while it loads, so the row doesn't jump; tap to see it big.
              <button
                type="button"
                onClick={() => setEnlarged(true)}
                aria-label="See the photo bigger"
                className="block h-40 w-full max-w-xs overflow-hidden rounded-md border border-border bg-muted"
              >
                {/* An authenticated API image (no next/image loader for it). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl(item.id)} alt={`Photo of “${item.task.title}”`} className="size-full object-cover" />
              </button>
            ) : null}
            {item.steps.length > 0 ? (
              <ul className="space-y-0.5 text-sm">
                {item.steps.map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded border',
                        s.ticked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                      )}
                      aria-hidden
                    >
                      {s.ticked ? <Check className="size-3" /> : null}
                    </span>
                    <span className={cn('min-w-0 break-words', !s.ticked && 'text-muted-foreground')}>{s.title}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      {decides ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={onSendBack} disabled={busy}>
            <X /> Send back
          </Button>
          <Button type="button" size="sm" onClick={onApprove} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />} Approve
          </Button>
        </div>
      ) : null}
      {enlarged ? (
        <Dialog open onClose={() => setEnlarged(false)} title={item.task.title} description={item.child.name}>
          {/* Fixed height, so the dialog doesn't grow when the picture arrives. */}
          <div className="flex h-[65dvh] items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photoUrl(item.id)} alt={`Photo of “${item.task.title}”`} className="max-h-full max-w-full object-contain" />
          </div>
        </Dialog>
      ) : null}
    </li>
  );
}

/**
 * "Send “Dishes” back to Riley": what needs fixing (required), and for a
 * task check, the steps to do again. A steps check sends back all its
 * entries; one counted as done when the day ended takes its points back.
 */
function SendBackDialog({
  item,
  onClose,
  onDone,
}: {
  item: TaskSubmissionDTO;
  onClose: () => void;
  onDone: () => void;
}) {
  const formId = useId();
  const noteId = useId();
  const [note, setNote] = useState('');
  const [redo, setRedo] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cycleEnd = isCycleEnd(item);
  // Only a task check picks steps, and only the ones that were ticked.
  const redoChoices = item.kind === 'task' && !cycleEnd ? item.steps.filter((s) => s.ticked) : [];

  const send = useMutation({
    mutationFn: () =>
      apiFetch<Decided>('/api/tasks/submissions/decide', {
        method: 'POST',
        body: JSON.stringify({
          submissionId: item.id,
          decision: 'send_back',
          reviewNote: note.trim(),
          ...(redo.length ? { redoStepIds: redo } : {}),
        }),
      }),
    onSuccess: () => {
      toast.success(
        cycleEnd
          ? `Took back ${item.child.name}’s points for “${item.task.title}”`
          : `Sent “${item.task.title}” back to ${item.child.name}`,
      );
      onDone();
    },
    onError: (err) => {
      const fields = fieldErrors(err);
      if (fields.reviewNote || fields.redoStepIds) {
        setError(fields.reviewNote ?? fields.redoStepIds);
      } else if (movedOn(err)) {
        // Someone already decided it, or its day ended meanwhile: say so and look again.
        toast.error((err as Error).message);
        onDone();
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Send “${item.task.title}” back to ${item.child.name}`}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={send.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={send.isPending || !note.trim()}>
            {send.isPending ? <Loader2 className="animate-spin" /> : <Undo2 />}
            Send back
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim() && !send.isPending) send.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={noteId}>What needs fixing?</Label>
          <Textarea
            id={noteId}
            required
            maxLength={300}
            rows={3}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${formId}-error`}
          />
          <FieldNote id={`${formId}-error`} error={error} />
        </div>
        {item.kind === 'steps' ? (
          <p className="text-sm text-muted-foreground">This sends back all of these. No points are paid for them.</p>
        ) : cycleEnd ? (
          <p className="text-sm text-muted-foreground">
            This takes back the {plusPoints(item.points)}. The task stays done for that day.
          </p>
        ) : redoChoices.length > 0 ? (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Steps to do again (optional)</legend>
            {redoChoices.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 rounded border-input"
                  checked={redo.includes(s.id)}
                  onChange={(e) =>
                    setRedo((list) => (e.target.checked ? [...list, s.id] : list.filter((id) => id !== s.id)))
                  }
                />
                <span className="min-w-0 break-words">{s.title}</span>
              </label>
            ))}
            <p className="text-xs text-muted-foreground">Steps you leave alone stay done and keep their points.</p>
          </fieldset>
        ) : null}
      </form>
    </Dialog>
  );
}
