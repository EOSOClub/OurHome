import type { BillDTO, BillPaymentDTO } from '@/lib/types';
import { roundCents } from '@/lib/money';

// The sums the payment dialog shows. Money is whole cents; a difference of
// two amounts isn't (89.99 - 45 is 44.989999999999995), so these round.

const toCents = roundCents;

/**
 * What's left to pay on the bill's current balance. When editing a payment,
 * that payment is taken back out of the paid total, so the dialog shows the
 * balance the edited amount is applied against; only when it is part of that
 * total, though: a recurring bill's payment for an earlier cycle never was.
 */
export function balanceLeft(
  bill: Pick<BillDTO, 'amount' | 'paidTotal'>,
  payment?: Pick<BillPaymentDTO, 'amount' | 'countsTowardBalance'>,
): number {
  const editing = payment?.countsTowardBalance ? payment.amount : 0;
  return Math.max(0, toCents(bill.amount - bill.paidTotal + editing));
}

/** A money value as an amount box shows it: whole cents, no float residue. */
export function moneyText(n: number): string {
  return String(toCents(n));
}
