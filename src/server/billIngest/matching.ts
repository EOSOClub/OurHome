import { Prisma } from '@prisma/client';
import type { BillIngestInput } from '@/lib/validation/billIngest';

// How a receipt finds the bill it pays when the importer has to work that out
// itself (the Paperless import), and the card-fee band used both to accept a
// near match and to split a fee off the charged amount.

// Plausible card/convenience-fee band, used to (a) accept a biller+timing match
// whose amount differs from its bill only by a surcharge, and (b) split a
// receipt's charged amount into applied-to-balance vs. fee so the bill still
// reads as paid in full. Tune these from real receipts (see Phase 5).
const FEE_MAX_PCT = 0.04;
const FEE_MAX_FLAT = 6;

/** Upper bound on a plausible fee for a bill of the given balance. */
export function feeCeiling(billAmount: number): number {
  return Math.max(FEE_MAX_FLAT, billAmount * FEE_MAX_PCT);
}

export type MatchedBill = Prisma.BillGetPayload<{ include: { recurrence: true } }>;

/** The bill a receipt pays, by OurHome's own matching; null when none fits. */
export async function findMatchingBill(
  tx: Prisma.TransactionClient,
  householdId: string,
  doc: BillIngestInput,
  reference: string,
  amount: number,
): Promise<MatchedBill | null> {
  // Match to an existing bill, the strongest signal first:
  //   1. a shared real invoice/confirmation number (reference),
  //   2. the same account number - a strong identifier; amounts may legitimately
  //      differ (partial payments, or a payment toward a past-due balance),
  //   3. biller + timing: the newest still-unpaid bill from the same biller
  //      whose amount matches within a card-fee band. This is the "the next
  //      receipt from a biller pays that biller's bill" case, where the receipt
  //      shares no reference/account and its amount differs only by the fee.
  //      The biller is `billerKey` when the importer has one (Paperless
  //      correspondent), else the sender's email.
  let match = await tx.bill.findFirst({
    where: { householdId, reference },
    include: { recurrence: true },
  });
  if (!match && doc.accountNo) {
    // Only open bills - a payment clears what's still owed. (Ordering by status
    // here is a trap: "paid" sorts before "unpaid", which would misroute the
    // payment onto an already-settled bill sharing the account number.)
    match = await tx.bill.findFirst({
      where: { householdId, accountNo: doc.accountNo, status: 'unpaid' },
      include: { recurrence: true },
      orderBy: { createdAt: 'desc' }, // most recently issued open bill
    });
  }
  const biller: Prisma.BillWhereInput | null = doc.billerKey
    ? { billerKey: doc.billerKey }
    : doc.billerEmail
      ? { billerEmail: doc.billerEmail }
      : null;
  if (!match && biller) {
    // Newest-first so a receipt clears the most recently issued open bill; the
    // amount-band filter guards against linking an unrelated bill from the same
    // biller (a wildly different amount falls through to "create a paid bill").
    const candidates = await tx.bill.findMany({
      where: { householdId, ...biller, status: 'unpaid' },
      include: { recurrence: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    match =
      candidates.find(
        (c) =>
          amount >= c.amount - 0.005 &&
          amount <= c.amount + feeCeiling(c.amount) + 0.005,
      ) ?? null;
  }
  return match;
}

/**
 * Split the charged amount into what's applied to the balance vs. a card
 * fee. Prefer an explicit split from the parser; otherwise infer the fee
 * from any overage within the fee band so the bill still reads paid in full.
 */
export function splitFee(
  doc: BillIngestInput,
  amount: number,
  outstanding: number,
  billAmount: number,
): { applied: number; fee: number } {
  let applied: number;
  let fee: number;
  if (doc.fee != null) {
    fee = doc.fee;
    applied = doc.baseAmount ?? Math.max(0, amount - fee);
  } else if (amount > outstanding && amount - outstanding <= feeCeiling(billAmount) + 0.005) {
    applied = outstanding;
    fee = amount - outstanding;
  } else {
    applied = amount;
    fee = 0;
  }
  return { applied, fee };
}

/**
 * The split a sender that pairs its own payments sent (OurHomeInbox, contract
 * v2): `fee` and `baseAmount` as they are, no fee band and nothing inferred
 * from the bill. Without `fee` there is no fee; without `baseAmount` it is the
 * amount less the sent fee, which is how the contract defines it.
 */
export function sentFee(doc: BillIngestInput, amount: number): { applied: number; fee: number } {
  const fee = doc.fee ?? 0;
  return { applied: doc.baseAmount ?? Math.max(0, amount - fee), fee };
}
