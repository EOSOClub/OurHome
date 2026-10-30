import { describe, expect, it } from 'vitest';
import { createBillSchema, updateBillSchema } from '@/lib/validation/bills';

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
