import { describe, expect, it } from 'vitest';
import { billIngestSchema } from '@/lib/validation/billIngest';
import {
  evaluateDocument,
  parseDay,
  parseMonetary,
  type MappingContext,
  type PaperlessDocument,
} from '@/server/paperless/mapping';

const BILL = 1;
const PAYMENT = 2;
const REVIEW = 9;

const ctx: MappingContext = {
  kindTags: new Map([
    [BILL, 'bill'],
    [PAYMENT, 'receipt'],
  ]),
  pendingTagIds: new Set([REVIEW]),
  fields: { amount: 2, dueDate: 3, accountNo: 5 },
  correspondents: new Map([[7, 'City Water']]),
  publicUrl: 'https://paperless.example.com/',
};

function doc(over: Partial<PaperlessDocument> = {}): PaperlessDocument {
  return {
    id: 42,
    title: 'City Water bill - October',
    correspondent: 7,
    tags: [BILL],
    created: '2026-10-02',
    modified: '2026-10-02T15:04:05.123456-05:00',
    custom_fields: [
      { field: 2, value: 'USD57.39' },
      { field: 3, value: '2026-10-20' },
      { field: 5, value: 'AC-1001' },
    ],
    ...over,
  };
}

describe('parseMonetary', () => {
  it('reads Paperless monetary values, with and without a currency', () => {
    expect(parseMonetary('USD57.39')).toEqual({ amount: 57.39, currency: 'USD' });
    expect(parseMonetary('EUR1664.5')).toEqual({ amount: 1664.5, currency: 'EUR' });
    expect(parseMonetary('USD-5.00')).toEqual({ amount: -5, currency: 'USD' });
    expect(parseMonetary('57.39')).toEqual({ amount: 57.39, currency: null });
    expect(parseMonetary(12)).toEqual({ amount: 12, currency: null });
  });

  it('treats empty and malformed values as missing', () => {
    for (const v of ['', null, undefined, '$57.39', 'USD', '57,39', NaN]) {
      expect(parseMonetary(v)).toBeNull();
    }
  });
});

describe('parseDay', () => {
  it('pins a date to local noon so no timezone moves it a day', () => {
    const d = parseDay('2026-10-20')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 20, 12]);
    expect(parseDay('not a date')).toBeNull();
    expect(parseDay(null)).toBeNull();
  });
});

describe('evaluateDocument', () => {
  it('maps a tagged bill to a valid importer input', () => {
    const result = evaluateDocument(doc(), ctx);
    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.input).toMatchObject({
      kind: 'bill',
      messageId: 'paperless:42',
      subject: 'City Water bill - October',
      biller: 'City Water',
      billerKey: 'paperless-correspondent:7',
      amount: 57.39,
      currency: 'USD',
      accountNo: 'AC-1001',
      paidDate: null,
      sourceUrl: 'https://paperless.example.com/documents/42/details',
    });
    expect(result.input.dueDate?.getDate()).toBe(20);
    // It must pass the importer's own validation.
    expect(billIngestSchema.safeParse(result.input).success).toBe(true);
  });

  it('maps a bill payment to a receipt paid on the document date, with no due date', () => {
    const result = evaluateDocument(doc({ tags: [PAYMENT] }), ctx);
    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.input.kind).toBe('receipt');
    expect(result.input.dueDate).toBeNull();
    expect(result.input.paidDate?.getDate()).toBe(2);
  });

  it('waits for documents that are not finished yet', () => {
    expect(evaluateDocument(doc({ custom_fields: [] }), ctx)).toEqual({ ready: false, reason: 'no Amount yet' });
    expect(evaluateDocument(doc({ tags: [BILL, REVIEW] }), ctx)).toEqual({
      ready: false,
      reason: 'waiting for review in Paperless',
    });
  });

  it('refuses ambiguous or untagged documents', () => {
    expect(evaluateDocument(doc({ tags: [BILL, PAYMENT] }), ctx).ready).toBe(false);
    expect(evaluateDocument(doc({ tags: [] }), ctx).ready).toBe(false);
  });

  it('copes with no correspondent, no due date and no public URL', () => {
    const result = evaluateDocument(
      doc({ correspondent: null, custom_fields: [{ field: 2, value: '0.00' }] }),
      { ...ctx, publicUrl: null },
    );
    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.input).toMatchObject({ biller: null, billerKey: null, dueDate: null, sourceUrl: null, amount: 0 });
  });
});
