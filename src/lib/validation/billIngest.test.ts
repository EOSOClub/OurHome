import { describe, expect, it } from 'vitest';
import { billIngestSchema } from '@/lib/validation/billIngest';

const receipt = { kind: 'receipt', messageId: 'paperless-document:42' };

describe('billIngestSchema sourceUrl', () => {
  it('accepts an http(s) link and trims it', () => {
    const r = billIngestSchema.safeParse({ ...receipt, sourceUrl: ' https://paperless.example/documents/42/details ' });
    expect(r.success).toBe(true);
    expect(r.data?.sourceUrl).toBe('https://paperless.example/documents/42/details');
  });

  it('refuses other schemes', () => {
    expect(billIngestSchema.safeParse({ ...receipt, sourceUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(billIngestSchema.safeParse({ ...receipt, sourceUrl: 'ftp://files.example/42' }).success).toBe(false);
  });

  it('refuses text that is not a link instead of throwing', () => {
    expect(() => billIngestSchema.safeParse({ ...receipt, sourceUrl: 'not a link' })).not.toThrow();
    expect(billIngestSchema.safeParse({ ...receipt, sourceUrl: 'not a link' }).success).toBe(false);
  });

  it('is optional', () => {
    expect(billIngestSchema.safeParse(receipt).success).toBe(true);
    expect(billIngestSchema.safeParse({ ...receipt, sourceUrl: null }).success).toBe(true);
  });
});
