import { describe, expect, it } from 'vitest';
import { InboxReplyError, helloSchema, parseDocumentsReply as parseIn } from '@/server/inbox/mapping';

// The household's zone; days become noon there.
const TZ = 'America/Chicago';
const parseDocumentsReply = (body: unknown, after: number, publicUrl: string | null) => parseIn(body, after, publicUrl, TZ);

// The example replies from the contract (OurHomeInbox vault,
// 03 - OurHome Integration/Hand-off.md, section 6), as OurHomeInbox sends them.
const readyMidco = {
  number: 43,
  captureId: 'proton-bill-label/118112344/1',
  link: '/mail/proton-bill-label/118112344/1',
  status: 'ready',
  document: {
    kind: 'receipt',
    messageId: '<abc123@emails.midco.com>',
    biller: 'Midco',
    billerKey: 'ourhomeinbox-biller:3',
    billerEmail: 'midco@emails.midco.com',
    subject: 'Midco Payment Posted',
    amount: 114.93,
    paidDate: '2026-10-26',
    emailDate: '2026-10-28T14:03:11.000Z',
    accountNo: 'XXXX-1234',
  },
};
const withdrawn = {
  number: 44,
  captureId: 'proton-bill-label/118112344/7',
  link: '/mail/proton-bill-label/118112344/7',
  status: 'withdrawn',
  messageId: '<def456@emails.midco.com>',
  reason: 'Marked Not a bill in OurHomeInbox.',
};
const contractReply = { documents: [readyMidco, withdrawn], next: 44, more: false };

describe('the hello reply', () => {
  it('reads the contract example', () => {
    expect(helloSchema.parse({ household: 'The Smiths', newest: 42, startDate: '2026-11-01' })).toMatchObject({ newest: 42 });
  });
});

describe('parseDocumentsReply', () => {
  it('reads the contract example: a ready receipt and a withdrawn email', () => {
    const page = parseDocumentsReply(contractReply, 42, 'https://inbox.example.org/');
    expect(page).toMatchObject({ next: 44, more: false });
    const [ready, gone] = page.entries;
    expect(ready).toMatchObject({ status: 'ready', number: 43, title: 'Midco Payment Posted', problem: null });
    if (ready.status !== 'ready' || !ready.input) throw new Error('expected a ready document');
    expect(ready.input).toMatchObject({
      kind: 'receipt',
      messageId: '<abc123@emails.midco.com>',
      billerKey: 'ourhomeinbox-biller:3',
      amount: 114.93,
      accountNo: 'XXXX-1234',
      // OurHome builds the link: the public address followed by `link`.
      sourceUrl: 'https://inbox.example.org/mail/proton-bill-label/118112344/1',
    });
    expect(ready.url).toBe('https://inbox.example.org/mail/proton-bill-label/118112344/1');
    expect(gone).toEqual({
      status: 'withdrawn',
      number: 44,
      captureId: 'proton-bill-label/118112344/7',
      messageId: '<def456@emails.midco.com>',
      reason: 'Marked Not a bill in OurHomeInbox.',
    });
  });

  it('takes a day as noon in the household zone, so no time zone moves it a day', () => {
    const page = parseDocumentsReply(contractReply, 42, null);
    const ready = page.entries[0];
    if (ready.status !== 'ready' || !ready.input) throw new Error('expected a ready document');
    // Oct 26 is still daylight time in Chicago (UTC-5): noon there is 17:00 UTC,
    // whatever zone the server itself runs in.
    expect(ready.input.paidDate?.toISOString()).toBe('2026-10-26T17:00:00.000Z');
    expect(ready.input.emailDate?.toISOString()).toBe('2026-10-28T14:03:11.000Z');
    // Another household's zone gives noon there.
    const tokyo = parseIn(contractReply, 42, null, 'Asia/Tokyo').entries[0];
    if (tokyo.status !== 'ready' || !tokyo.input) throw new Error('expected a ready document');
    expect(tokyo.input.paidDate?.toISOString()).toBe('2026-10-26T03:00:00.000Z');
  });

  it('keeps the v2 fields of a paired payment: its bill’s reference, the fee split and paid late', () => {
    const paired = {
      ...readyMidco,
      document: { ...readyMidco.document, reference: 'ohi:0123456789abcdef01234567', fee: 3.5, baseAmount: 111.43, paidLate: true },
    };
    const ready = parseDocumentsReply({ documents: [paired], next: 43, more: false }, 42, null).entries[0];
    if (ready.status !== 'ready') throw new Error('expected a ready document');
    expect(ready.problem).toBeNull();
    expect(ready.input).toMatchObject({ reference: 'ohi:0123456789abcdef01234567', fee: 3.5, baseAmount: 111.43, paidLate: true });

    // A bill carries its own reference (v2) and comes through with it.
    const bill = { ...readyMidco, document: { kind: 'bill', messageId: '<bill@x>', reference: 'INV-778', amount: 111.43, dueDate: '2026-11-05' } };
    const billEntry = parseDocumentsReply({ documents: [bill], next: 43, more: false }, 42, null).entries[0];
    if (billEntry.status !== 'ready') throw new Error('expected a ready document');
    expect(billEntry.input).toMatchObject({ kind: 'bill', reference: 'INV-778' });
  });

  it('refuses a paid late that is not true or false', () => {
    const doc = { ...readyMidco, document: { ...readyMidco.document, paidLate: 'yes' } };
    const entry = parseDocumentsReply({ documents: [doc], next: 43, more: false }, 42, null).entries[0];
    expect(entry).toMatchObject({ input: null });
    expect((entry as { problem: string }).problem).toMatch(/paidLate/);
  });

  it('makes no link without a public address, and ignores a link OurHomeInbox sent itself', () => {
    const doc = { ...readyMidco, document: { ...readyMidco.document, sourceUrl: 'https://elsewhere.example/x' } };
    const ready = parseDocumentsReply({ documents: [doc], next: 43, more: false }, 42, null).entries[0];
    if (ready.status !== 'ready') throw new Error('expected a ready document');
    expect(ready.url).toBeNull();
    expect(ready.input?.sourceUrl).toBeNull();
  });

  it('refuses a link to another site', () => {
    for (const link of ['//evil.example/mail', 'https://evil.example/mail', '/\\evil.example']) {
      expect(() => parseDocumentsReply({ documents: [{ ...readyMidco, link }], next: 43, more: false }, 42, 'https://inbox.example.org')).toThrow(InboxReplyError);
    }
  });

  it('lists a document OurHome cannot read as a problem, and still reads the rest', () => {
    const bad = { ...readyMidco, number: 43, document: { ...readyMidco.document, amount: -5 } };
    const good = { ...readyMidco, number: 45, captureId: 'x/1/2' };
    const page = parseDocumentsReply({ documents: [bad, good], next: 45, more: false }, 42, null);
    expect(page.entries[0]).toMatchObject({ status: 'ready', input: null, title: 'Midco Payment Posted' });
    expect((page.entries[0] as { problem: string }).problem).toMatch(/can't read.*\(amount: [^)]*[^.]\)\.$/);
    expect(page.entries[1]).toMatchObject({ status: 'ready', problem: null });
  });

  it('treats a statement as a problem: it is not in the contract', () => {
    const doc = { ...readyMidco, document: { ...readyMidco.document, kind: 'statement' } };
    const entry = parseDocumentsReply({ documents: [doc], next: 43, more: false }, 42, null).entries[0];
    expect(entry).toMatchObject({ input: null, problem: 'a statement, not a bill or payment' });
  });

  it('throws on a reply that breaks the contract, so nothing is skipped past', () => {
    // Numbers must rise and be past `after`.
    expect(() => parseDocumentsReply({ documents: [readyMidco], next: 43, more: false }, 43, null)).toThrow(/out of order/);
    expect(() => parseDocumentsReply({ documents: [withdrawn, readyMidco], next: 44, more: false }, 0, null)).toThrow(/out of order/);
    // `next` can't go back before what it sent.
    expect(() => parseDocumentsReply({ documents: [readyMidco], next: 40, more: false }, 0, null)).toThrow(/continue after 40/);
    // An entry without a number, a withdrawn one without its Message-ID, a reply without `more`.
    expect(() => parseDocumentsReply({ documents: [{ status: 'ready' }], next: 1, more: false }, 0, null)).toThrow(InboxReplyError);
    expect(() => parseDocumentsReply({ documents: [{ ...withdrawn, messageId: undefined }], next: 44, more: false }, 0, null)).toThrow(InboxReplyError);
    expect(() => parseDocumentsReply({ documents: [], next: 0 }, 0, null)).toThrow(InboxReplyError);
  });

  it('accepts an empty reply that stays where it is', () => {
    expect(parseDocumentsReply({ documents: [], next: 7, more: false }, 7, null)).toEqual({ entries: [], next: 7, more: false });
  });
});
