import { describe, expect, it } from 'vitest';
import { roundCents } from './money';

describe('roundCents', () => {
  it('rounds half a cent up, where n * 100 rounding went down', () => {
    expect(roundCents(1.005)).toBe(1.01);
    expect(roundCents(2.675)).toBe(2.68);
    expect(roundCents(1234.565)).toBe(1234.57);
  });

  it('removes float residue', () => {
    expect(roundCents(44.989999999999995)).toBe(44.99);
    expect(roundCents(3.450000000000003)).toBe(3.45);
    expect(roundCents(0.1 + 0.2)).toBe(0.3);
  });

  it('keeps whole and two-decimal amounts as they are', () => {
    expect(roundCents(100)).toBe(100);
    expect(roundCents(12.34)).toBe(12.34);
    expect(roundCents(0)).toBe(0);
  });

  it('rounds negatives away from zero, and works on tiny and large values', () => {
    expect(roundCents(-1.005)).toBe(-1.01);
    expect(roundCents(1e-7)).toBe(0);
    expect(roundCents(999999.995)).toBe(1000000);
  });
});
