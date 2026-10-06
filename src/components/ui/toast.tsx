'use client';

import * as React from 'react';
import { create } from 'zustand';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * App-wide toast notifications — no external dependency, mirroring the Dialog
 * approach. State lives in a zustand store so non-React code (e.g. the global
 * MutationCache error handler in providers.tsx) can raise toasts too:
 *
 *   import { toast } from '@/components/ui/toast';
 *   toast.success('Bill paid');
 *   toast.error('Could not save task');
 *
 * `<Toaster />` renders the stack; it is mounted once in the root layout.
 */

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastData {
  id: number;
  variant: ToastVariant;
  message: string;
  /** Optional action rendered as a small button (e.g. Undo). */
  action?: { label: string; onClick: () => void };
}

interface ToastStore {
  toasts: ToastData[];
  push: (t: Omit<ToastData, 'id'>) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    set((s) => ({
      // Keep the stack shallow; oldest drops first past 4.
      toasts: [...s.toasts.slice(-3), { ...t, id }],
    }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

function push(variant: ToastVariant, message: string, action?: ToastData['action']) {
  return useToastStore.getState().push({ variant, message, action });
}

export const toast = {
  success: (message: string, action?: ToastData['action']) =>
    push('success', message, action),
  error: (message: string, action?: ToastData['action']) =>
    push('error', message, action),
  info: (message: string, action?: ToastData['action']) =>
    push('info', message, action),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
};

const ICONS: Record<ToastVariant, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const AUTO_DISMISS_MS = 5000;

function ToastItem({ data }: { data: ToastData }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = ICONS[data.variant];

  React.useEffect(() => {
    // Errors stay until dismissed; success/info clear themselves.
    if (data.variant === 'error') return;
    const timer = setTimeout(() => dismiss(data.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [data.id, data.variant, dismiss]);

  return (
    <div
      role={data.variant === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto flex w-full max-w-sm items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-3 shadow-lg"
    >
      <Icon
        className={cn(
          'size-5 shrink-0',
          data.variant === 'success' && 'text-success',
          data.variant === 'error' && 'text-destructive',
          data.variant === 'info' && 'text-muted-foreground',
        )}
      />
      <p className="min-w-0 flex-1 text-sm">{data.message}</p>
      {data.action ? (
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-accent"
          onClick={() => {
            data.action?.onClick();
            dismiss(data.id);
          }}
        >
          {data.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss notification"
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => dismiss(data.id)}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    // Sits above the mobile bottom nav (h-16 + safe area); tighter on desktop.
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:items-end sm:px-6">
      {toasts.map((t) => (
        <ToastItem key={t.id} data={t} />
      ))}
    </div>
  );
}
