import { describe, expect, it } from 'vitest';
import { balanceLeft, moneyText } from './payment-amounts';

describe('the payment dialog amounts', () => {
  it('prefills what is left in whole cents', () => {
    // 89.99 - 45 is 44.989999999999995 in floating point.
    expect(moneyText(balanceLeft({ amount: 89.99, paidTotal: 45 }))).toBe('44.99');
    expect(moneyText(balanceLeft({ amount: 75.3, paidTotal: 25.1 }))).toBe('50.2');
    expect(moneyText(balanceLeft({ amount: 153.27, paidTotal: 100 }))).toBe('53.27');
    // An imported fee stored with residue shows as cents too.
    expect(moneyText(103.45 - 100)).toBe('3.45');
  });

  it('never goes below nothing left', () => {
    expect(balanceLeft({ amount: 100, paidTotal: 120 })).toBe(0);
  });

  it('adds the edited payment back only when it counts toward the balance', () => {
    // A recurring bill on a new cycle: last month's payment is not part of it.
    expect(balanceLeft({ amount: 100, paidTotal: 0 }, { amount: 100, countsTowardBalance: false })).toBe(100);
    // This cycle's part payment is.
    expect(balanceLeft({ amount: 100, paidTotal: 40 }, { amount: 40, countsTowardBalance: true })).toBe(100);
  });
});
