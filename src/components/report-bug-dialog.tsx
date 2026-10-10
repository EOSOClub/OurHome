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

/**
 * The "Report a bug" form, opened from the user menu. The current page path
 * is sent as context; the head is notified and support is emailed server-side.
 */
export function ReportBugDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const close = () => {
    onClose();
    setTitle('');
    setDescription('');
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
      toast.success('Thanks — your bug report was sent.');
      close();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSubmit = title.trim().length >= 3 && description.trim().length > 0 && !submit.isPending;

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
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bug-title">What&apos;s wrong?</Label>
            <Input
              id="bug-title"
              value={title}
              maxLength={150}
              placeholder="e.g. Bills page won't load"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bug-description">Details</Label>
            <Textarea
              id="bug-description"
              value={description}
              maxLength={5000}
              rows={5}
              placeholder="What did you do, what did you expect, and what happened instead?"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">Page: {pathname}</p>
        </div>
      </Dialog>
    </>
  );
}
