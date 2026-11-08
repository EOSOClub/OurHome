/**
 * An amount of money rounded to whole cents, half away from zero.
 *
 * `Math.round(n * 100) / 100` gets some values wrong because the
 * multiplication happens in binary: 1.005 * 100 is 100.49999999999999, so it
 * came out as 1.00 instead of 1.01. Shifting the decimal point through the
 * number's own decimal text ("1.005e2") rounds what was actually typed.
 */
export function roundCents(n: number): number {
  if (!Number.isFinite(n)) return n;
  const sign = n < 0 ? -1 : 1;
  const text = String(Math.abs(n));
  // Very small or very large numbers print in exponent form ("1e-7"), where
  // the shift below doesn't apply; no half cent is ambiguous there anyway.
  if (text.includes('e')) return sign * (Math.round(Math.abs(n) * 100) / 100);
  const cents = Math.round(Number(`${text}e2`));
  return sign * Number(`${cents}e-2`);
}
