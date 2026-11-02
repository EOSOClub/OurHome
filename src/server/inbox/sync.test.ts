import { beforeEach, describe, expect, it, vi } from 'vitest';

// The OurHomeInbox import: paging through the feed, keeping the number only
// once a whole reply is handled, what each kind of document becomes, and the
// changes reported back first (contract v2).

type SyncRow = { householdId: string; after: number; lastResult: string | null; lastError: string | null };
let sync: SyncRow | null = null;
type QueuedChange = { id: string; messageId: string; change: string; at: Date; sentAt: Date | null; rejected?: string | null };
let queue: QueuedChange[] = [];
const conn = { householdId: 'h1', url: 'http://ourhome_inbox:8080', publicUrl: 'https://inbox.example.org', tokenEnc: 'enc', remoteHousehold: 'The Smiths', createdAt: new Date() };

const prisma = {
  inboxConnection: {
    findUnique: vi.fn(async (): Promise<typeof conn | null> => conn),
    findMany: vi.fn(async () => [{ householdId: 'h1' }]),
    count: vi.fn(async () => 1),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  inboxSync: {
    findUnique: vi.fn(async () => sync),
    create: vi.fn(async ({ data }: { data: { householdId: string; after: number } }) => (sync = { ...data, lastResult: null, lastError: null })),
    update: vi.fn(async ({ data }: { data: Partial<SyncRow> }) => (sync = { ...sync!, ...data })),
    updateMany: vi.fn(),
    deleteMany: vi.fn(async () => {
      sync = null;
    }),
  },
  // The queue of changes to report (changes.ts runs for real against it).
  inboxChange: {
    findMany: vi.fn(async ({ take }: { take: number }) => queue.filter((c) => !c.sentAt).slice(0, take)),
    updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: { sentAt: Date } }) => {
      for (const c of queue) if (where.id.in.includes(c.id)) c.sentAt = data.sentAt;
      return { count: where.id.in.length };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<QueuedChange> }) => {
      const row = queue.find((c) => c.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
    count: vi.fn(
      async ({ where }: { where: { messageId: string; change: string } }) =>
        queue.filter((c) => c.messageId === where.messageId && c.change === where.change).length,
    ),
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(async (fn: unknown) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn as unknown[]))),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/security/secrets', () => ({ decryptSecret: () => `ohi_${'a'.repeat(43)}`, encryptSecret: () => 'enc' }));
const admin = { isFeatureEnabled: vi.fn(async () => true), isHouseholdDisabled: vi.fn(async () => false) };
vi.mock('@/server/services/serverAdminService', () => admin);
vi.mock('@/server/services/paperlessSync', () => ({
  paperlessMayUsePrivateNetwork: vi.fn(async () => true),
  hasPaperless: vi.fn(async () => false),
}));
const ingest = {
  ingestFinancialDoc: vi.fn(
    async (_h: string, doc: { kind: string }): Promise<{ status: string; reason?: string }> => ({
      status: doc.kind === 'bill' ? 'created' : 'linked',
    }),
  ),
  withdrawEmailDoc: vi.fn(async (): Promise<Record<string, unknown>> => ({ status: 'removed', billId: 'b1' })),
};
vi.mock('@/server/billIngest/ingest', () => ingest);
vi.mock('@/server/inbox/withdraw', () => ingest);

// The feed: each ask gets the next queued reply (or a thrown error).
const replies: unknown[] = [];
const asked: number[] = [];
// Every request to OurHomeInbox in order, to check the changes go first.
const requests: string[] = [];
const changes = vi.fn(async (list: unknown[]): Promise<unknown> => {
  requests.push('changes');
  return { accepted: list.length, unknown: 0 };
});
const hello = vi.fn(async (): Promise<unknown> => ({ household: 'The Smiths', newest: 0, startDate: '2026-11-01' }));
// The real InboxError (changes.ts tells OurHomeInbox's refusals apart by it); a fake client.
vi.mock('@/server/inbox/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/inbox/client')>()),
  InboxClient: class {
    hello = hello;
    changes = changes;
    async documents(after: number) {
      asked.push(after);
      requests.push('documents');
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next ?? { documents: [], next: after, more: false };
    }
  },
}));

const { runInboxSync, saveInboxConnection, removeInboxConnection } = await import('./sync');
const { InboxError } = await import('@/server/inbox/client');

const ready = (number: number, kind = 'bill') => ({
  number,
  captureId: `cap/${number}`,
  link: `/mail/cap/${number}`,
  status: 'ready',
  document: { kind, messageId: `<m${number}@x>`, subject: `Email ${number}`, amount: 10 },
});

beforeEach(() => {
  vi.clearAllMocks();
  sync = { householdId: 'h1', after: 0, lastResult: null, lastError: null };
  replies.length = 0;
  asked.length = 0;
  requests.length = 0;
  changes.mockReset();
  queue = [];
});

describe('runInboxSync', () => {
  it('imports ready documents as email bills, with OurHome’s own link to the email', async () => {
    replies.push({ documents: [ready(1), ready(2, 'receipt')], next: 2, more: false });
    const result = await runInboxSync('h1');
    expect(asked).toEqual([0]);
    expect(ingest.ingestFinancialDoc).toHaveBeenCalledTimes(2);
    const [household, doc, opts] = ingest.ingestFinancialDoc.mock.calls[0] as unknown as [string, Record<string, unknown>, unknown];
    expect(household).toBe('h1');
    expect(doc).toMatchObject({ kind: 'bill', messageId: '<m1@x>', sourceUrl: 'https://inbox.example.org/mail/cap/1' });
    // OurHomeInbox pairs its payments itself (contract v2).
    expect(opts).toEqual({ source: 'email', receiptPairing: 'reference' });
    expect(result?.imported).toEqual({ created: 1, linked: 1 });
    expect(sync?.after).toBe(2);
    expect(sync?.lastError).toBeNull();
  });

  it('asks again straight away while there is more, from the number it was given', async () => {
    replies.push({ documents: [ready(1)], next: 1, more: true }, { documents: [ready(2)], next: 2, more: false });
    await runInboxSync('h1');
    expect(asked).toEqual([0, 1]);
    expect(sync?.after).toBe(2);
  });

  it('keeps the old number when a document fails half way, so the same ones come again', async () => {
    replies.push({ documents: [ready(1), ready(2)], next: 2, more: false });
    ingest.ingestFinancialDoc.mockResolvedValueOnce({ status: 'created' }).mockRejectedValueOnce(new Error('database down'));
    await expect(runInboxSync('h1')).rejects.toThrow('database down');
    expect(sync?.after).toBe(0);
    expect(sync?.lastError).toBe('database down');
  });

  it('keeps the old number on a reply that breaks the contract', async () => {
    replies.push({ documents: [ready(3), ready(2)], next: 3, more: false });
    await expect(runInboxSync('h1')).rejects.toThrow(/out of order/);
    expect(ingest.ingestFinancialDoc).not.toHaveBeenCalled();
    expect(sync?.after).toBe(0);
  });

  it('takes back what a withdrawn email made, and lists one it kept with a link to the bill', async () => {
    const gone = (number: number) => ({ number, captureId: `cap/${number}`, link: `/mail/cap/${number}`, status: 'withdrawn', messageId: `<m${number}@x>`, reason: 'Marked Not a bill in OurHomeInbox.' });
    replies.push({ documents: [gone(1), gone(2), gone(3)], next: 3, more: false });
    ingest.withdrawEmailDoc
      .mockResolvedValueOnce({ status: 'removed', billId: 'b1' })
      .mockResolvedValueOnce({ status: 'kept', billId: 'b2', billName: 'City Water', reason: 'a payment is recorded on this bill: delete it by hand if it isn’t a bill' })
      .mockResolvedValueOnce({ status: 'nothing' });
    const result = await runInboxSync('h1');
    expect(ingest.withdrawEmailDoc).toHaveBeenCalledWith('h1', '<m1@x>');
    expect(result?.imported).toEqual({ removed: 1, kept: 1, withdrawn: 1 });
    expect(result?.skipped).toEqual([
      {
        id: 'cap/2',
        title: 'City Water',
        reason: 'Marked Not a bill in OurHomeInbox. Kept here: a payment is recorded on this bill: delete it by hand if it isn’t a bill.',
        url: '/bills/b2',
      },
    ]);
  });

  it('lists skipped documents with why, newest first, and drops one once it comes in', async () => {
    replies.push({ documents: [ready(1, 'receipt'), ready(2, 'receipt')], next: 2, more: false });
    ingest.ingestFinancialDoc
      .mockResolvedValueOnce({ status: 'skipped', reason: 'no matching unpaid bill' })
      .mockResolvedValueOnce({ status: 'skipped', reason: 'no matching unpaid bill' });
    const first = await runInboxSync('h1');
    expect(first?.skipped.map((s) => s.id)).toEqual(['cap/2', 'cap/1']);
    expect(first?.skipped[0]).toMatchObject({ title: 'Email 2', url: 'https://inbox.example.org/mail/cap/2' });

    // Offered again later (fixed in OurHomeInbox) and imported this time.
    replies.push({ documents: [{ ...ready(5, 'receipt'), captureId: 'cap/1' }], next: 5, more: false });
    const second = await runInboxSync('h1');
    expect(second?.skipped.map((s) => s.id)).toEqual(['cap/2']);
  });

  it('starts at 0 the first time', async () => {
    sync = null;
    replies.push({ documents: [ready(1)], next: 1, more: false });
    await runInboxSync('h1');
    expect(prisma.inboxSync.create).toHaveBeenCalledWith({ data: { householdId: 'h1', after: 0 } });
    expect(asked).toEqual([0]);
  });

  it('stops asking when OurHomeInbox says there is more but sends nothing', async () => {
    replies.push({ documents: [], next: 0, more: true }, { documents: [ready(1)], next: 1, more: false });
    await runInboxSync('h1');
    expect(asked).toEqual([0]);
  });

  it('the sweep leaves turned-off households and ones without Bills alone', async () => {
    admin.isHouseholdDisabled.mockResolvedValueOnce(true);
    await runInboxSync();
    expect(asked).toEqual([]);
    admin.isFeatureEnabled.mockResolvedValueOnce(false);
    await runInboxSync();
    expect(asked).toEqual([]);
  });

  it('the sweep logs one household’s failure and returns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    replies.push(new Error('unreachable'));
    await expect(runInboxSync()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('reporting changes back (contract v2)', () => {
  const queued = (n: number, change = 'paid'): QueuedChange[] =>
    Array.from({ length: n }, (_, i) => ({ id: `c${i}`, messageId: `<b${i}@x>`, change, at: new Date(Date.UTC(2026, 10, 3, 15, 20, i)), sentAt: null }));

  it('sends the queued changes before asking for documents, and marks them sent', async () => {
    queue = queued(2);
    queue[1].change = 'removed';
    replies.push({ documents: [ready(1)], next: 1, more: false });
    await runInboxSync('h1');
    expect(requests).toEqual(['changes', 'documents']);
    expect(changes).toHaveBeenCalledWith([
      { messageId: '<b0@x>', change: 'paid', at: '2026-11-03T15:20:00.000Z' },
      { messageId: '<b1@x>', change: 'removed', at: '2026-11-03T15:20:01.000Z' },
    ]);
    expect(queue.every((c) => c.sentAt instanceof Date)).toBe(true);
    expect(sync?.lastError).toBeNull();
  });

  it('sends at most 100 changes a request', async () => {
    queue = queued(250);
    await runInboxSync('h1');
    expect(changes.mock.calls.map(([list]) => list.length)).toEqual([100, 100, 50]);
    expect(queue.filter((c) => !c.sentAt)).toEqual([]);
  });

  it('sends nothing when nothing is queued', async () => {
    await runInboxSync('h1');
    expect(changes).not.toHaveBeenCalled();
    expect(requests).toEqual(['documents']);
  });

  it('keeps the changes when sending fails, still imports, and shows why on the card', async () => {
    queue = queued(150);
    changes
      .mockImplementationOnce(async (list: unknown[]) => ({ accepted: list.length, unknown: 0 }))
      .mockRejectedValueOnce(new InboxError('OurHomeInbox answered 500 for /api/handoff/changes.', 500));
    replies.push({ documents: [ready(1)], next: 1, more: false });
    const result = await runInboxSync('h1');
    // The first 100 went; the other 50 wait for the next run.
    expect(queue.filter((c) => c.sentAt).length).toBe(100);
    expect(queue.filter((c) => !c.sentAt).map((c) => c.id)).toEqual(queue.slice(100).map((c) => c.id));
    // The documents still came in, and the number moved on.
    expect(ingest.ingestFinancialDoc).toHaveBeenCalledOnce();
    expect(result?.imported).toEqual({ created: 1 });
    expect(sync?.after).toBe(1);
    expect(sync?.lastError).toBe(
      'OurHomeInbox wasn’t told about bills paid or deleted here. It will be told on the next check. (OurHomeInbox answered 500 for /api/handoff/changes.)',
    );

    // The next run sends the rest, and the message goes.
    replies.push({ documents: [], next: 1, more: false });
    await runInboxSync('h1');
    expect(queue.every((c) => c.sentAt)).toBe(true);
    expect(sync?.lastError).toBeNull();
  });
});

describe('saveInboxConnection', () => {
  it('tests the connection first and saves nothing when it fails', async () => {
    hello.mockRejectedValueOnce(new Error('OurHomeInbox rejected the token.'));
    await expect(saveInboxConnection('h1', { url: 'http://ourhome_inbox:8080', token: `ohi_${'b'.repeat(43)}` })).rejects.toThrow(
      'Couldn’t use that OurHomeInbox: OurHomeInbox rejected the token.',
    );
    expect(prisma.inboxConnection.upsert).not.toHaveBeenCalled();
  });

  it('refuses an address that answers but is not OurHomeInbox', async () => {
    hello.mockResolvedValueOnce({ hello: 'world' });
    await expect(saveInboxConnection('h1', { url: 'http://something:80', token: `ohi_${'b'.repeat(43)}` })).rejects.toThrow(/not like OurHomeInbox/);
  });

  it('keeps the progress for a new token to the same OurHomeInbox household', async () => {
    sync = { householdId: 'h1', after: 40, lastResult: null, lastError: null };
    await saveInboxConnection('h1', { url: 'http://ourhome_inbox:8080/', token: `ohi_${'b'.repeat(43)}` });
    expect(prisma.inboxConnection.upsert).toHaveBeenCalledOnce();
    expect(prisma.inboxSync.deleteMany).not.toHaveBeenCalled();
  });

  it('starts over for a different address or a different OurHomeInbox household', async () => {
    await saveInboxConnection('h1', { url: 'http://other_inbox:8080', token: null });
    expect(prisma.inboxSync.deleteMany).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    hello.mockResolvedValueOnce({ household: 'The Joneses', newest: 3 });
    await saveInboxConnection('h1', { url: 'http://ourhome_inbox:8080', token: null });
    expect(prisma.inboxSync.deleteMany).toHaveBeenCalledOnce();
  });
});

describe('review fixes: the queue and removed bills', () => {
  const at = new Date('2026-11-03T15:20:00.000Z');
  const change = (id: string, messageId: string, kind = 'paid', sentAt: Date | null = null): QueuedChange => ({ id, messageId, change: kind, at, sentAt });

  it('resends a refused batch one change at a time, and marks the one still refused as done', async () => {
    queue = [change('c0', '<b0@x>'), change('c1', 'not-a-message-id'), change('c2', '<b2@x>')];
    changes.mockImplementation(async (list: unknown[]) => {
      requests.push('changes');
      if ((list as { messageId: string }[]).some((c) => c.messageId === 'not-a-message-id')) {
        throw new InboxError('changes.0.messageId: not an email Message-ID.', 400);
      }
      return { accepted: list.length, unknown: 0 };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runInboxSync('h1');
    warn.mockRestore();
    // The batch of 3, then each on its own.
    expect(changes.mock.calls.map(([list]) => list.length)).toEqual([3, 1, 1, 1]);
    expect(queue.every((c) => c.sentAt instanceof Date)).toBe(true);
    expect(queue.find((c) => c.id === 'c1')?.rejected).toBe('changes.0.messageId: not an email Message-ID.');
    expect(queue.filter((c) => c.rejected).map((c) => c.id)).toEqual(['c1']);
    expect(sync?.lastError).toBeNull();

    // It never holds up the queue again.
    changes.mockClear();
    queue.push(change('c3', '<b3@x>'));
    await runInboxSync('h1');
    expect(changes.mock.calls.map(([list]) => list)).toEqual([[{ messageId: '<b3@x>', change: 'paid', at: at.toISOString() }]]);
  });

  it('says plainly on the card when the queue itself could not be read, and still imports', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    prisma.inboxChange.findMany.mockRejectedValueOnce(new Error('MongoServerError: connection reset'));
    replies.push({ documents: [ready(1)], next: 1, more: false });
    const result = await runInboxSync('h1');
    warn.mockRestore();
    expect(result?.imported).toEqual({ created: 1 });
    expect(sync?.lastError).toBe(
      'OurHomeInbox wasn’t told about bills paid or deleted here. It will be told on the next check. (Couldn’t read the list of changes to send.)',
    );
  });

  it('skips an email whose bill someone deleted here, even when offered again', async () => {
    queue = [change('r1', '<m1@x>', 'removed', new Date())];
    replies.push({ documents: [ready(1), ready(2)], next: 2, more: false });
    const result = await runInboxSync('h1');
    // Only the other email comes in.
    expect(ingest.ingestFinancialDoc).toHaveBeenCalledOnce();
    expect((ingest.ingestFinancialDoc.mock.calls[0] as unknown as [string, { messageId: string }])[1].messageId).toBe('<m2@x>');
    expect(result?.imported).toEqual({ skipped: 1, created: 1 });
    expect(result?.skipped).toEqual([
      { id: 'cap/1', title: 'Email 1', reason: 'Someone deleted this bill here', url: 'https://inbox.example.org/mail/cap/1' },
    ]);
    expect(prisma.inboxChange.count).toHaveBeenCalledWith({ where: { householdId: 'h1', messageId: '<m1@x>', change: 'removed' } });
  });

  it('keeps the change reports on Disconnect, so deleted bills stay deleted after a reconnect', async () => {
    await removeInboxConnection('h1');
    expect(prisma.inboxConnection.deleteMany).toHaveBeenCalledOnce();
    expect(prisma.inboxChange.deleteMany).not.toHaveBeenCalled();
  });
});

describe('follow-up: the one-at-a-time resend', () => {
  const at = new Date('2026-11-03T15:20:00.000Z');
  const change = (id: string, messageId: string): QueuedChange => ({ id, messageId, change: 'paid', at, sentAt: null });
  // The batch is refused (400); each change on its own gets `answer(messageId)`.
  const answering = (answer: (messageId: string) => Error | null) =>
    changes.mockImplementation(async (list: unknown[]) => {
      requests.push('changes');
      if (list.length > 1) throw new InboxError('changes.1.messageId: not an email Message-ID.', 400);
      const err = answer((list as { messageId: string }[])[0].messageId);
      if (err) throw err;
      return { accepted: 1, unknown: 0 };
    });

  it('stops on a 500 half way through, leaving the rest queued and unmarked', async () => {
    queue = [change('c0', '<b0@x>'), change('c1', '<b1@x>'), change('c2', '<b2@x>')];
    answering((id) => (id === '<b1@x>' ? new InboxError('OurHomeInbox answered 500 for /api/handoff/changes.', 500) : null));
    replies.push({ documents: [ready(1)], next: 1, more: false });
    const result = await runInboxSync('h1');
    expect(changes.mock.calls.map(([list]) => list.length)).toEqual([3, 1, 1]);
    expect(queue.find((c) => c.id === 'c0')?.sentAt).toBeInstanceOf(Date);
    for (const id of ['c1', 'c2']) {
      expect(queue.find((c) => c.id === id)).toMatchObject({ sentAt: null });
      expect(queue.find((c) => c.id === id)?.rejected).toBeUndefined();
    }
    expect(result?.imported).toEqual({ created: 1 });
    expect(sync?.lastError).toMatch(/\(OurHomeInbox answered 500 for \/api\/handoff\/changes\.\)$/);
  });

  it('does not treat a 401 on a batch as a refusal: nothing is resent or set aside', async () => {
    queue = [change('c0', '<b0@x>'), change('c1', '<b1@x>')];
    changes.mockRejectedValueOnce(new InboxError('This token was revoked.', 401));
    await runInboxSync('h1');
    expect(changes).toHaveBeenCalledOnce();
    expect(queue.every((c) => c.sentAt === null && c.rejected === undefined)).toBe(true);
    expect(sync?.lastError).toMatch(/\(This token was revoked\.\)$/);
  });

  it('sets nothing aside after 3 refusals in a row, and leaves the rest queued', async () => {
    queue = ['c0', 'c1', 'c2', 'c3', 'c4'].map((id, i) => change(id, i === 0 ? '<b0@x>' : `bad-${i}`));
    answering((id) => (id.startsWith('bad') ? new InboxError('changes.0.change: unknown change.', 400) : null));
    await runInboxSync('h1');
    // c0 goes, c1 to c3 are refused in a row, c4 is never tried.
    expect(changes.mock.calls.map(([list]) => list.length)).toEqual([5, 1, 1, 1, 1]);
    expect(queue.find((c) => c.id === 'c0')?.sentAt).toBeInstanceOf(Date);
    expect(queue.filter((c) => c.sentAt === null).map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(queue.some((c) => c.rejected)).toBe(false);
    expect(sync?.lastError).toMatch(/refused 3 changes in a row, so none was set aside/);
  });
});
