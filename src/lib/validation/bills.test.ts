import { describe, expect, it } from 'vitest';
import { createBillSchema, markBillPaidSchema, updateBillSchema, updatePaymentSchema } from '@/lib/validation/bills';

const ID = 'cmabcdefghijklmnopqrstuvw';
const base = { name: 'Netflix', amount: 15.49 };

describe('bill kinds', () => {
  it('is a bill unless it says subscription', () => {
    expect(createBillSchema.parse(base).kind).toBe('bill');
    expect(createBillSchema.parse({ ...base, kind: 'subscription' }).kind).toBe('subscription');
    expect(createBillSchema.safeParse({ ...base, kind: 'loan' }).success).toBe(false);
  });

  it('only a subscription has a free trial', () => {
    const trialEndsAt = '2026-11-15T18:00:00.000Z';
    expect(createBillSchema.safeParse({ ...base, kind: 'subscription', trialEndsAt }).success).toBe(true);
    expect(createBillSchema.safeParse({ ...base, trialEndsAt }).success).toBe(false);
    expect(updateBillSchema.safeParse({ id: ID, kind: 'bill', trialEndsAt }).success).toBe(false);
    // Without a kind the service checks the stored one.
    expect(updateBillSchema.safeParse({ id: ID, trialEndsAt }).success).toBe(true);
  });

  it('takes only web links for the pay or manage link', () => {
    expect(createBillSchema.safeParse({ ...base, website: 'https://netflix.com/account' }).success).toBe(true);
    expect(createBillSchema.safeParse({ ...base, website: 'javascript:alert(1)' }).success).toBe(false);
  });
});

describe('bill amounts', () => {
  it('are rounded to the cent', () => {
    expect(createBillSchema.parse({ ...base, amount: 12.345678 }).amount).toBe(12.35);
    expect(createBillSchema.parse({ ...base, amount: 0.1 + 0.2 }).amount).toBe(0.3);
    expect(updateBillSchema.parse({ id: ID, amount: 9.999 }).amount).toBe(10);
    expect(markBillPaidSchema.parse({ id: ID, amount: 5.004, fee: 1.006 })).toMatchObject({ amount: 5, fee: 1.01 });
    expect(updatePaymentSchema.parse({ id: ID, amount: 3.333, fee: null })).toMatchObject({ amount: 3.33, fee: null });
    // Whole cents and leaving it out are unchanged.
    expect(createBillSchema.parse(base).amount).toBe(15.49);
    expect(markBillPaidSchema.parse({ id: ID }).amount).toBeUndefined();
  });

  it('still refuses negative and huge amounts', () => {
    expect(createBillSchema.safeParse({ ...base, amount: -1 }).success).toBe(false);
    expect(createBillSchema.safeParse({ ...base, amount: 1_000_001 }).success).toBe(false);
  });
});
