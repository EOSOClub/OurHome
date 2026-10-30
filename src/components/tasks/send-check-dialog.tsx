'use client';

import { useId, useRef, useState } from 'react';
import { Camera, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import type { TaskDTO } from '@/lib/types';
import { ApiError, apiFetch, fieldErrors } from '@/lib/api';
import { checkCode, decideByLine, type CheckCode } from '@/lib/taskChecks';
import { encodeTaskPhoto, type EncodedPhoto } from '@/lib/taskPhoto';
import { useHouseholdZone } from '@/components/household-zone';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FieldNote } from '@/components/ui/field-note';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/** What POST /api/tasks/complete answers when a task was sent for a check. */
export type SentForCheck = TaskDTO & { completionId: string | null; submissionId: string | null };

const KEPT = 'Couldn’t send it. Your photo is kept, try again.';
const UNREADABLE = 'That photo couldn’t be read. Take it again.';

/**
 * "Send “Dishes” for a check": a teen or child someone looks after sends a
 * task to them instead of completing it (Task Photo Proof). A photo taken
 * with the phone's camera (or picked), turned upright and shrunk here
 * (lib/taskPhoto.ts), and a note. A task that asks for a photo can still be
 * sent without one, with a note saying why. On a failed send the photo stays.
 */
export function SendCheckDialog({
  task,
  onClose,
  onSent,
  onClosedByServer,
}: {
  task: TaskDTO;
  onClose: () => void;
  onSent: (result: SentForCheck) => void;
  /**
   * Sending can't go through from here: the check was turned off meanwhile
   * (check_not_needed: complete it the usual way), or the task already waits
   * (check_waiting, check_already_waiting). The caller closes and says why.
   */
  onClosedByServer: (message: string, code: CheckCode) => void;
}) {
  const timeZone = useHouseholdZone();
  const formId = useId();
  const noteId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<EncodedPhoto | null>(null);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const photoRequired = task.photoProof;
  // Without the photo a task asks for, the note says why (the server checks too).
  const withoutPhoto = photoRequired && !photo;
  const canSend = !sending && !reading && (!withoutPhoto || note.trim().length > 0);

  async function onPicked(file: File | undefined) {
    if (!file) return;
    setReading(true);
    setError(null);
    try {
      setPhoto(await encodeTaskPhoto(file));
    } catch {
      setError(UNREADABLE);
    } finally {
      setReading(false);
      // So picking the same file again still counts as a change.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const result = await apiFetch<SentForCheck>('/api/tasks/complete', {
        method: 'POST',
        body: JSON.stringify({
          taskId: task.id,
          checks: 1,
          forCheck: true,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(photo ? { photo: photo.base64 } : {}),
        }),
      });
      onSent(result);
    } catch (err) {
      const code = checkCode(err);
      if (!(err instanceof ApiError) || err.status >= 500) {
        setError(KEPT);
      } else if (code === 'check_not_needed' || code === 'check_waiting' || code === 'check_already_waiting') {
        onClosedByServer(err.message, code);
      } else {
        // check_cap, update_app, 413, 422, 429 and the rest: say it here, keep what was entered.
        const fields = fieldErrors(err);
        // A photo the server can't read won't go through again: take another.
        if (err.status === 422 && fields.photo && photo) setPhoto(null);
        setError(fields.photo ?? fields.note ?? err.message);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Send “${task.title}” for a check`}
      description="An adult will look at it before the points are paid."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!canSend}>
            {sending ? <Loader2 className="animate-spin" /> : null}
            {withoutPhoto ? 'Send without a photo' : 'Send for a check'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {/* One fixed-height box for the button and the preview, so nothing jumps. */}
        <div className="flex h-48 items-center justify-center overflow-hidden rounded-md border border-dashed border-border bg-muted/40">
          {photo ? (
            // A data: URL made here; next/image has nothing to optimise.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo.dataUrl} alt="Your photo" className="size-full object-contain" />
          ) : (
            <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={reading || sending}>
              {reading ? <Loader2 className="animate-spin" /> : <Camera />}
              Take a photo
            </Button>
          )}
        </div>
        {photo ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={reading || sending}
            >
              {reading ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              Take again
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPhoto(null)} disabled={sending}>
              <Trash2 /> Remove photo
            </Button>
          </div>
        ) : photoRequired ? (
          <div className="space-y-0.5 text-sm">
            <p className="font-medium">This task needs a photo.</p>
            <p className="text-muted-foreground">Can’t take a photo? Say why in the note.</p>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor={noteId}>{withoutPhoto ? 'Note' : 'Note (optional)'}</Label>
          <Textarea
            id={noteId}
            value={note}
            maxLength={500}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            aria-invalid={error && !photo && withoutPhoto ? true : undefined}
          />
        </div>

        {task.cycleEndsAt ? (
          <p className="text-xs text-muted-foreground">{decideByLine(task.cycleEndsAt, timeZone)}</p>
        ) : null}
        <FieldNote id={`${formId}-error`} error={error} />
        {/* Last, so the dialog's first focus lands on Take a photo, not on this. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => void onPicked(e.target.files?.[0])}
        />
      </form>
    </Dialog>
  );
}
