'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { BillDTO, BillPaymentDTO } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { apiFetch, ApiError } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog } from '@/components/ui/dialog';

const pad = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Record-payment modal shared by the bills list ("Mark paid") and the bill
 * detail page. Prefilled with the outstanding balance so paying in full is a
 * single confirm, while still allowing partial amounts, fees, and backdating.
 * Accepts the list DTO — the remaining balance is derived, not read off the
 * detail-only DTO. Pass `payment` to edit an existing payment instead.
 */
export function PaymentDialog({
  bill,
  payment,
  onClose,
  onSaved,
}: {
  bill: BillDTO;
  payment?: BillPaymentDTO;
  onClose: () => void;
  onSaved: () => void;
}) {
  // When editing, exclude this payment from the paid total so the helper text
  // shows the balance the edited amount is applied against.
  const remaining = Math.max(
    0,
    bill.amount - bill.paidTotal + (payment?.amount ?? 0),
  );
  const originalDate = payment ? dateValue(new Date(payment.paidAt)) : null;
  const [amount, setAmount] = useState(
    payment ? String(payment.amount) : remaining > 0 ? String(remaining) : '',
  );
  const [fee, setFee] = useState(payment?.fee ? String(payment.fee) : '');
  const [paidAt, setPaidAt] = useState(originalDate ?? dateValue(new Date()));
  const [note, setNote] = useState(payment?.notes ?? '');
  const [confirmationNo, setConfirmationNo] = useState(
    payment?.confirmationNo ?? '',
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      payment
        ? apiFetch('/api/bills/payments/update', {
            method: 'POST',
            body: JSON.stringify({
              id: payment.id,
              amount: Number(amount) || 0,
              fee: fee ? Number(fee) : null,
              notes: note.trim() || null,
              confirmationNo: confirmationNo.trim() || null,
              // Untouched date ⇒ omit, preserving the original timestamp.
              paidAt:
                paidAt && paidAt !== originalDate
                  ? new Date(`${paidAt}T12:00`).toISOString()
                  : undefined,
            }),
          })
        : apiFetch('/api/bills/pay', {
            method: 'POST',
            body: JSON.stringify({
              id: bill.id,
              amount: Number(amount) || 0,
              fee: fee ? Number(fee) : undefined,
              note: note.trim() || undefined,
              paidAt: paidAt ? new Date(`${paidAt}T12:00`).toISOString() : undefined,
            }),
          }),
    onSuccess: () => {
      toast.success(payment ? 'Payment updated' : 'Payment recorded');
      onSaved();
    },
    onError: (err) =>
      setError(
        err instanceof ApiError
          ? err.message
          : `Failed to ${payment ? 'update' : 'record'} payment`,
      ),
  });

  const canSubmit = amount !== '' && Number(amount) >= 0;
  const submit = () => {
    if (canSubmit && !save.isPending) save.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={payment ? 'Edit payment' : 'Record payment'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {/* Lives outside the <form> element (Dialog footer), hence form="…". */}
          <Button
            type="submit"
            form="payment-form"
            disabled={save.isPending || !canSubmit}
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </>
      }
    >
      <form
        id="payment-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pay-amount">Amount paid</Label>
            <Input
              id="pay-amount"
              type="number"
              min={0}
              step="0.01"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-fee">Card fee (optional)</Label>
            <Input
              id="pay-fee"
              type="number"
              min={0}
              step="0.01"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-date">Date</Label>
            <Input
              id="pay-date"
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
            />
          </div>
          {payment ? (
            <div className="space-y-1.5">
              <Label htmlFor="pay-confirmation">Confirmation #</Label>
              <Input
                id="pay-confirmation"
                value={confirmationNo}
                onChange={(e) => setConfirmationNo(e.target.value)}
                placeholder="optional"
              />
            </div>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pay-note">Note</Label>
          <Textarea
            id="pay-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="optional"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Applied to a {formatMoney(bill.amount, bill.currency)} balance ·{' '}
          {formatMoney(remaining, bill.currency)} remaining. The fee is recorded
          but doesn&apos;t count toward the balance.
        </p>
      </form>
    </Dialog>
  );
}
