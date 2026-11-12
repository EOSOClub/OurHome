'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { BillDTO, BillPaymentDTO } from '@/lib/types';
import { dateKey, formatMoney, zonedInstant } from '@/lib/format';
import { useHouseholdZone } from '@/components/household-zone';
import { apiFetch, ApiError } from '@/lib/api';
import { useFieldErrors } from '@/lib/use-field-errors';
import { FieldNote } from '@/components/ui/field-note';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog } from '@/components/ui/dialog';
import { balanceLeft, moneyText } from '@/components/bills/payment-amounts';

// A picked day is stored at 12:00 in the household's zone (Settings), and
// read back in it, whatever zone the device is in.
const noonIn = (date: string, timeZone?: string) => zonedInstant(date, '12:00', timeZone).toISOString();

/**
 * Record-payment modal shared by the bill list ("Mark paid") and the bill
 * detail page. Prefilled with the outstanding balance, so paying in full takes
 * a single confirmation, while still allowing partial amounts, fees, and
 * backdating.
 * Accepts the list DTO - the remaining balance is derived, not read off the
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
  // When editing, exclude this payment from the paid total (when it is in
  // it), so the helper text shows the balance the edited amount is applied
  // against. In whole cents, so the amount box never shows float residue.
  const remaining = balanceLeft(bill, payment);
  const timeZone = useHouseholdZone();
  const originalDate = payment ? dateKey(payment.paidAt, timeZone) : null;
  const [amount, setAmount] = useState(
    payment ? moneyText(payment.amount) : remaining > 0 ? moneyText(remaining) : '',
  );
  const [fee, setFee] = useState(payment?.fee ? moneyText(payment.fee) : '');
  const [paidAt, setPaidAt] = useState(originalDate ?? dateKey(new Date(), timeZone));
  const [note, setNote] = useState(payment?.notes ?? '');
  const [confirmationNo, setConfirmationNo] = useState(
    payment?.confirmationNo ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  // Which fields the server named; the reason is said in the alert at the top.
  const fe = useFieldErrors('pay');

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
                  ? noonIn(paidAt, timeZone)
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
              paidAt: paidAt ? noonIn(paidAt, timeZone) : undefined,
            }),
          }),
    onSuccess: () => {
      toast.success(payment ? 'Payment updated' : 'Payment recorded');
      onSaved();
    },
    onError: (err) => {
      setError(
        err instanceof ApiError
          ? err.message
          : `Failed to ${payment ? 'update' : 'record'} payment`,
      );
      fe.mark(err);
    },
  });

  const canSubmit = amount !== '' && Number(amount) >= 0;
  const submit = () => {
    if (canSubmit && !save.isPending) save.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      // A stray tap outside must not throw away the payment being typed.
      preventOutsideClose
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
        {...fe.formProps}
      >
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5" data-field="amount">
            <Label htmlFor="pay-amount">Amount paid</Label>
            <Input
              id="pay-amount"
              type="number"
              min={0}
              step="0.01"
              data-autofocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              {...fe.invalid('amount')}
            />
            <FieldNote id={fe.noteId('amount')} error={fe.get('amount')} />
          </div>
          <div className="space-y-1.5" data-field="fee">
            <Label htmlFor="pay-fee">Card fee (optional)</Label>
            <Input
              id="pay-fee"
              type="number"
              min={0}
              step="0.01"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="0.00"
              {...fe.invalid('fee')}
            />
            <FieldNote id={fe.noteId('fee')} error={fe.get('fee')} />
          </div>
          <div className="space-y-1.5" data-field="paidAt">
            <Label htmlFor="pay-date">Date</Label>
            <Input
              id="pay-date"
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              {...fe.invalid('paidAt')}
            />
            <FieldNote id={fe.noteId('paidAt')} error={fe.get('paidAt')} />
          </div>
          {payment ? (
            <div className="space-y-1.5" data-field="confirmationNo">
              <Label htmlFor="pay-confirmation">Confirmation #</Label>
              <Input
                id="pay-confirmation"
                value={confirmationNo}
                onChange={(e) => setConfirmationNo(e.target.value)}
                placeholder="optional"
                {...fe.invalid('confirmationNo')}
              />
              <FieldNote id={fe.noteId('confirmationNo')} error={fe.get('confirmationNo')} />
            </div>
          ) : null}
        </div>
        {/* Sent as "note" when recording, "notes" when editing. */}
        <div className="space-y-1.5" data-field="note notes">
          <Label htmlFor="pay-note">Note</Label>
          <Textarea
            id="pay-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="optional"
            {...fe.invalid('note', 'notes')}
          />
          <FieldNote id={fe.noteId('note')} error={fe.first('note', 'notes')} />
        </div>
        <p className="text-xs text-muted-foreground">
          Applied to a {formatMoney(bill.amount, bill.currency)} balance ·{' '}
          {formatMoney(remaining, bill.currency)}{' '}
          remaining. The fee is recorded but doesn&apos;t count toward the
          balance.
        </p>
      </form>
    </Dialog>
  );
}
