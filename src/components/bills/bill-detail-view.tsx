'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  Repeat,
  Trash2,
} from 'lucide-react';
import type { BillDTO, BillDetailDTO, BillPaymentDTO, MemberDTO } from '@/lib/types';
import { canModify, type PageAccess } from '@/lib/permissions';
import { BILL_STATUS_LABELS, type BillStatus } from '@/lib/enums';
import { formatDate, formatDueDate, formatMoney, isOverdue, safeHref } from '@/lib/format';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { BillDialog, duplicateBillPayload } from '@/components/bills/bills-view';
import { PaymentDialog } from '@/components/bills/payment-dialog';

const KEY = ['bills'];

const pad = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function sourceLabel(source: string): string {
  return source === 'email'
    ? 'Email (auto)'
    : source === 'paperless'
      ? 'Paperless (auto)'
      : source === 'import'
        ? 'Import'
        : 'Manual';
}

export function BillDetailView({
  bill,
  members,
  access,
  userId,
  canAddToCalendar,
}: {
  bill: BillDetailDTO;
  members: MemberDTO[];
  /** The viewer's Bills access (Members → Permissions). */
  access: PageAccess;
  userId: string;
  /** Viewer may add calendar events (Calendar "Add"). */
  canAddToCalendar: boolean;
}) {
  // Paying and duplicating add records (Add); edit/delete follow own vs others'.
  const canEdit = canModify(access, 'edit', bill.createdById, userId);
  const canDelete = canModify(access, 'delete', bill.createdById, userId);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addedToCalendar, setAddedToCalendar] = useState(false);

  // Re-render the server component and drop the stale list cache.
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: KEY });
    router.refresh();
  };

  const remove = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>('/api/bills/delete', {
        method: 'POST',
        body: JSON.stringify({ id: bill.id }),
      }),
    onSuccess: () => {
      toast.success('Bill deleted');
      queryClient.invalidateQueries({ queryKey: KEY });
      router.push('/bills');
    },
  });

  const duplicate = useMutation({
    mutationFn: () =>
      apiFetch<BillDTO>('/api/bills', {
        method: 'POST',
        body: JSON.stringify(duplicateBillPayload(bill)),
      }),
    onSuccess: (created) => {
      toast.success('Bill duplicated');
      queryClient.invalidateQueries({ queryKey: KEY });
      router.push(`/bills/${created.id}`);
    },
  });

  // All-day calendar event on the due date, titled after the bill. Errors
  // surface via the global mutation toast; success swaps the button for a link.
  const addToCalendar = useMutation({
    mutationFn: () => {
      // Local midnight on the due date — the calendar's all-day convention.
      const due = dateValue(new Date(bill.dueDate!));
      return apiFetch('/api/calendar/events', {
        method: 'POST',
        body: JSON.stringify({
          title: bill.name,
          startAt: new Date(`${due}T00:00`).toISOString(),
          allDay: true,
        }),
      });
    },
    onSuccess: () => {
      setAddedToCalendar(true);
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
      toast.success('Added to calendar');
    },
  });

  const overdue = bill.status === 'unpaid' && isOverdue(bill.dueDate);
  const partial =
    bill.status === 'unpaid' && bill.paidTotal > 0 && bill.paidTotal < bill.amount;
  const statusVariant =
    bill.status === 'paid' ? 'success' : overdue ? 'destructive' : 'warning';
  const statusLabel = overdue
    ? 'Overdue'
    : partial
      ? 'Partially paid'
      : (BILL_STATUS_LABELS[bill.status as BillStatus] ?? bill.status);
  const pct =
    bill.amount > 0
      ? Math.min(100, Math.round((bill.paidTotal / bill.amount) * 100))
      : bill.status === 'paid'
        ? 100
        : 0;

  return (
    <div className="space-y-5">
      <Link
        href="/bills"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Bills
      </Link>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold">{bill.name}</h1>
                {bill.recurrence ? (
                  <Repeat className="size-4 text-muted-foreground" />
                ) : null}
                {bill.autoPay ? (
                  <Badge variant="secondary" className="text-[10px]">
                    Auto-pay
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                <CalendarClock className="size-4" />
                {bill.dueDate ? formatDueDate(bill.dueDate) : 'No due date'}
              </p>
            </div>
            <div className="text-right">
              <div className="text-3xl font-semibold tabular-nums">
                {formatMoney(bill.amount, bill.currency)}
              </div>
              <Badge variant={statusVariant} className="mt-1">
                {statusLabel}
              </Badge>
            </div>
          </div>

          <div className="space-y-1.5">
            {/* Decorative — the same numbers are in the text below. */}
            <div
              aria-hidden="true"
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-[var(--color-success)] transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
              <span>
                Paid {formatMoney(bill.paidTotal, bill.currency)} of{' '}
                {formatMoney(bill.amount, bill.currency)}
                {bill.feeTotal > 0
                  ? ` · ${formatMoney(bill.feeTotal, bill.currency)} in fees`
                  : ''}
              </span>
              <span>
                {bill.remaining > 0
                  ? `${formatMoney(bill.remaining, bill.currency)} remaining`
                  : 'Settled'}
              </span>
            </div>
          </div>

          {access.create || canEdit || canDelete || canAddToCalendar ? (
            <div className="flex flex-wrap gap-2">
              {access.create ? (
                <Button onClick={() => setPaying(true)}>
                  <CheckCircle2 />
                  {bill.remaining > 0 ? 'Record payment' : 'Add payment'}
                </Button>
              ) : null}
              {canEdit ? (
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
              ) : null}
              {access.create ? (
                <Button
                  variant="outline"
                  disabled={duplicate.isPending}
                  onClick={() => duplicate.mutate()}
                >
                  {duplicate.isPending ? <Loader2 className="animate-spin" /> : <Copy />}
                  Duplicate
                </Button>
              ) : null}
              {bill.dueDate && canAddToCalendar ? (
                addedToCalendar ? (
                  <Link href="/calendar" className={buttonVariants({ variant: 'outline' })}>
                    <CalendarPlus /> Open calendar
                  </Link>
                ) : (
                  <Button
                    variant="outline"
                    disabled={addToCalendar.isPending}
                    onClick={() => addToCalendar.mutate()}
                  >
                    {addToCalendar.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <CalendarPlus />
                    )}
                    Add to calendar
                  </Button>
                )
              ) : null}
              {canDelete ? (
                <Button
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => setConfirmDelete(true)}
                >
                  {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  Delete
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <Detail label="Category" value={bill.category} />
            <Detail label="Responsible" value={bill.assignee?.name} />
            <Detail label="Currency" value={bill.currency} />
            {bill.currentCharges != null ? (
              <Detail
                label="Current charges"
                value={formatMoney(bill.currentCharges, bill.currency)}
              />
            ) : null}
            <Detail label="Source" value={sourceLabel(bill.source)} />
            <Detail label="Account #" value={bill.accountNo} />
            <Detail label="Invoice #" value={bill.invoiceNo} />
            <Detail label="Confirmation #" value={bill.confirmationNo} />
            <Detail label="Reference" value={bill.reference} />
            <Detail label="Biller email" value={bill.billerEmail} />
          </dl>
          {safeHref(bill.sourceUrl) ? (
            <a
              href={safeHref(bill.sourceUrl)}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <ExternalLink className="size-4" /> Open in Paperless
            </a>
          ) : null}
          {bill.notes ? (
            <div className="mt-4">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Notes
              </dt>
              <dd className="mt-1 whitespace-pre-wrap text-sm">{bill.notes}</dd>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payments ({bill.paymentCount})</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {bill.payments.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="No payments yet"
              description="Record a payment to start tracking what's been paid."
            />
          ) : (
            <ul className="divide-y divide-border">
              {bill.payments.map((p) => (
                <PaymentRow
                  key={p.id}
                  bill={bill}
                  payment={p}
                  access={access}
                  userId={userId}
                  onChanged={refresh}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {paying ? (
        <PaymentDialog
          bill={bill}
          onClose={() => setPaying(false)}
          onSaved={() => {
            setPaying(false);
            refresh();
          }}
        />
      ) : null}
      {editing ? (
        <BillDialog
          bill={bill}
          members={members}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          remove.mutate();
        }}
        title="Delete bill"
        description={`Delete "${bill.name}"? This can't be undone.`}
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}

function Detail({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm">{value}</dd>
    </div>
  );
}

function PaymentRow({
  bill,
  payment,
  access,
  userId,
  onChanged,
}: {
  bill: BillDetailDTO;
  payment: BillPaymentDTO;
  access: PageAccess;
  userId: string;
  onChanged: () => void;
}) {
  // Own = payments the viewer recorded (not who paid).
  const canEdit = canModify(access, 'edit', payment.createdById, userId);
  const canDelete = canModify(access, 'delete', payment.createdById, userId);
  const currency = bill.currency;
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const remove = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>('/api/bills/payments/delete', {
        method: 'POST',
        body: JSON.stringify({ id: payment.id }),
      }),
    onSuccess: onChanged,
  });

  return (
    <li className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium tabular-nums">
          {formatMoney(payment.amount, currency)}
          {payment.fee ? (
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              + {formatMoney(payment.fee, currency)} fee
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {formatDate(payment.paidAt)}
          {payment.paidBy ? ` · ${payment.paidBy.name}` : ''}
          {payment.notes ? ` · ${payment.notes}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge
          variant={payment.source === 'manual' ? 'outline' : 'secondary'}
          className="text-[10px]"
        >
          {payment.source === 'manual' ? 'Manual' : 'Auto'}
        </Badge>
        {canEdit ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Edit payment"
            onClick={() => setEditing(true)}
          >
            <Pencil />
          </Button>
        ) : null}
        {canDelete ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            aria-label="Remove payment"
            disabled={remove.isPending}
            onClick={() => setConfirm(true)}
          >
            {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <PaymentDialog
          bill={bill}
          payment={payment}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          remove.mutate();
        }}
        title="Remove payment"
        description="Remove this payment record? The bill's paid status will be recalculated."
        confirmLabel="Remove"
        destructive
      />
    </li>
  );
}

