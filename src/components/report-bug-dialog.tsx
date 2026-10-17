'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors } from '@/lib/use-field-errors';

/**
 * The "Report a bug" form, opened from the user menu. The current page path
 * is sent as context; the head is notified and support is emailed server-side.
 */
export function ReportBugDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const fe = useFieldErrors('bug');

  const close = () => {
    onClose();
    setTitle('');
    setDescription('');
    fe.clear();
  };

  const submit = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>('/api/bug-reports', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          source: 'web',
          context: pathname,
        }),
      }),
    onSuccess: () => {
      toast.success('Thanks - your bug report was sent.');
      close();
    },
    onError: fe.fail,
  });

  const canSubmit = title.trim().length >= 3 && description.trim().length > 0 && !submit.isPending;
  const titleError =
    fe.get('title') ?? (title.length > 0 && title.trim().length < 3 ? 'At least 3 characters.' : null);

  return (
    <>
      <Dialog
        open={open}
        onClose={close}
        title="Report a bug"
        description="Tell us what went wrong. We'll include the page you're on."
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={submit.isPending}>
              Cancel
            </Button>
            <Button onClick={() => submit.mutate()} disabled={!canSubmit}>
              {submit.isPending ? <Loader2 className="animate-spin" /> : null}
              Send report
            </Button>
          </>
        }
      >
        <div className="space-y-4" {...fe.formProps}>
          <div className="space-y-1.5" data-field="title">
            <Label htmlFor="bug-title">What&apos;s wrong?</Label>
            <Input
              id="bug-title"
              value={title}
              maxLength={150}
              placeholder="e.g. Bills page won't load"
              onChange={(e) => setTitle(e.target.value)}
              aria-invalid={titleError ? true : undefined}
              aria-describedby={fe.noteId('title')}
            />
            <FieldNote id={fe.noteId('title')} error={titleError} />
          </div>
          <div className="space-y-1.5" data-field="description">
            <Label htmlFor="bug-description">Details</Label>
            <Textarea
              id="bug-description"
              value={description}
              maxLength={5000}
              rows={5}
              placeholder="What did you do, what did you expect, and what happened instead?"
              onChange={(e) => setDescription(e.target.value)}
              {...fe.invalid('description')}
            />
            <FieldNote id={fe.noteId('description')} error={fe.get('description')} />
          </div>
          <p className="text-xs text-muted-foreground">Page: {pathname}</p>
        </div>
      </Dialog>
    </>
  );
}
