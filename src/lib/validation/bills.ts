import { z } from 'zod';
import { BILL_STATUSES } from '@/lib/enums';
import { recurrenceInputSchema } from '@/lib/validation/task';

const amountSchema = z.number().nonnegative().max(1_000_000);

export const createBillSchema = z.object({
  name: z.string().trim().min(1).max(160),
  amount: amountSchema,
  // Optional — omitted by the bill form (server default "USD"); sent by the
  // Duplicate action so copies keep the source bill's currency.
  currency: z.string().trim().min(1).max(10).optional().nullable(),
  dueDate: z.coerce.date().optional().nullable(),
  category: z.string().trim().max(60).optional().nullable(),
  autoPay: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional().nullable(),
  assignedUserId: z.string().cuid().optional().nullable(),
  recurrence: recurrenceInputSchema.optional().nullable(),
});
export type CreateBillInput = z.infer<typeof createBillSchema>;

export const updateBillSchema = z.object({
  id: z.string().cuid(),
  name: z.string().trim().min(1).max(160).optional(),
  amount: amountSchema.optional(),
  dueDate: z.coerce.date().optional().nullable(),
  status: z.enum(BILL_STATUSES).optional(),
  category: z.string().trim().max(60).optional().nullable(),
  autoPay: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
  assignedUserId: z.string().cuid().optional().nullable(),
  recurrence: recurrenceInputSchema.optional().nullable(),
});
export type UpdateBillInput = z.infer<typeof updateBillSchema>;

export const markBillPaidSchema = z.object({
  id: z.string().cuid(),
  // Amount applied to the balance; defaults to the remaining balance server-side.
  amount: amountSchema.optional(),
  // Card/convenience surcharge charged on top of `amount`.
  fee: amountSchema.optional(),
  note: z.string().trim().max(500).optional(),
  paidAt: z.coerce.date().optional(),
});
export type MarkBillPaidInput = z.infer<typeof markBillPaidSchema>;

export const deletePaymentSchema = z.object({ id: z.string().cuid() });
export type DeletePaymentInput = z.infer<typeof deletePaymentSchema>;

// Editable fields mirror what recording a payment sets (plus confirmationNo for
// email-ingested receipts). `null` clears a field; omitted fields are untouched.
export const updatePaymentSchema = z.object({
  id: z.string().cuid(),
  amount: amountSchema.optional(),
  fee: amountSchema.optional().nullable(),
  paidAt: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional().nullable(),
  confirmationNo: z.string().trim().max(120).optional().nullable(),
});
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

export const billIdSchema = z.object({ id: z.string().cuid() });
export type BillIdInput = z.infer<typeof billIdSchema>;
