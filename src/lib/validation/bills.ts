import { z } from 'zod';
import { recordId } from '@/lib/validation/ids';
import { BILL_KINDS, BILL_STATUSES } from '@/lib/enums';
import { recurrenceInputSchema } from '@/lib/validation/task';
import { httpLink } from '@/lib/validation/shopping';

const amountSchema = z.number().nonnegative().max(1_000_000);

// What it is, and the fields that go with it: a bill's account number and pay
// link, a subscription's manage link and trial end.
const kindFields = {
  website: httpLink.optional().nullable(),
  accountNo: z.string().trim().max(60).optional().nullable(),
  trialEndsAt: z.coerce.date().optional().nullable(),
};
const trialOnSubscription = (b: { kind?: string; trialEndsAt?: Date | null }) =>
  !b.trialEndsAt || b.kind === 'subscription';
const trialError = {
  message: 'Only a subscription has a free trial.',
  path: ['trialEndsAt'],
};

export const createBillSchema = z.object({
  kind: z.enum(BILL_KINDS).default('bill'),
  ...kindFields,
  name: z.string().trim().min(1).max(160),
  amount: amountSchema,
  // Optional - omitted by the bill form (server default "USD"); sent by the
  // Duplicate action so copies keep the source bill's currency.
  currency: z.string().trim().min(1).max(10).optional().nullable(),
  dueDate: z.coerce.date().optional().nullable(),
  category: z.string().trim().max(60).optional().nullable(),
  autoPay: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional().nullable(),
  assignedUserId: recordId.optional().nullable(),
  recurrence: recurrenceInputSchema.optional().nullable(),
  // Made on the calendar: it goes on the calendar as it's saved.
  onCalendar: z.boolean().optional(),
}).refine(trialOnSubscription, trialError);
export type CreateBillInput = z.infer<typeof createBillSchema>;

export const updateBillSchema = z.object({
  id: recordId,
  // Switching to a bill clears the trial date (billService.updateBill).
  kind: z.enum(BILL_KINDS).optional(),
  ...kindFields,
  name: z.string().trim().min(1).max(160).optional(),
  amount: amountSchema.optional(),
  dueDate: z.coerce.date().optional().nullable(),
  status: z.enum(BILL_STATUSES).optional(),
  category: z.string().trim().max(60).optional().nullable(),
  autoPay: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
  assignedUserId: recordId.optional().nullable(),
  recurrence: recurrenceInputSchema.optional().nullable(),
}).refine((b) => b.kind !== 'bill' || !b.trialEndsAt, trialError);
export type UpdateBillInput = z.infer<typeof updateBillSchema>;

export const markBillPaidSchema = z.object({
  id: recordId,
  // Amount applied to the balance; defaults to the remaining balance server-side.
  amount: amountSchema.optional(),
  // Card/convenience surcharge charged on top of `amount`.
  fee: amountSchema.optional(),
  note: z.string().trim().max(500).optional(),
  paidAt: z.coerce.date().optional(),
});
export type MarkBillPaidInput = z.infer<typeof markBillPaidSchema>;

export const deletePaymentSchema = z.object({ id: recordId });

// Editable fields mirror what recording a payment sets (plus confirmationNo for
// email-ingested receipts). `null` clears a field; omitted fields are untouched.
export const updatePaymentSchema = z.object({
  id: recordId,
  amount: amountSchema.optional(),
  fee: amountSchema.optional().nullable(),
  paidAt: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional().nullable(),
  confirmationNo: z.string().trim().max(120).optional().nullable(),
});
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

export const billIdSchema = z.object({ id: recordId });
