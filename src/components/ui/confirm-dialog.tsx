'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

/**
 * Branded confirmation modal — a drop-in replacement for `window.confirm()`.
 * Built on the app's {@link Dialog} so it matches the rest of the UI (Escape /
 * backdrop click cancel, scroll lock) instead of the native "{website} says…"
 * browser popup. Controlled via `open`; call `onConfirm` for the action and
 * `onClose` for cancel.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  pending = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
    </Dialog>
  );
}
