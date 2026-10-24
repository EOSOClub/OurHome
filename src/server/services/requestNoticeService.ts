import type { Prisma } from '@prisma/client';

// Answers to a request: when someone else approves it, declines it, accepts it
// (maintenance) or marks it done or added, the requester gets a bell row
// (addressed to them alone) and a phone alert. The push is the request
// change's own: requestService.pushRequestChange always wakes the requester.
// At most one per request: a newer answer replaces it, and withdrawing the
// request removes it. Nobody is told about their own doing (a head approving
// their own purchase).

type Db = Prisma.TransactionClient;

export type RequestAnswer = 'approved' | 'accepted' | 'done' | 'declined';

export interface AnsweredRequest {
  id: string;
  category: string;
  title: string;
  year: number | null;
  issue: boolean | null;
  quantity: number | null;
  requesterId: string;
  dueAt: Date | null;
  addedToList: string | null;
  reply: string | null;
}

/** The request's name in the notice: "Dune (2021)", "2 × AA batteries", "Fix the faucet". */
function requestName(r: AnsweredRequest): string {
  if (r.category === 'media' && r.year) return `${r.title} (${r.year})`;
  if (r.category === 'purchase' && r.quantity && r.quantity > 1) return `${r.quantity} × ${r.title}`;
  return r.title;
}

/**
 * The notice text, e.g. title "Approved: LEGO set", body "Alex said yes and
 * added it to Groceries." The outcome leads the title, so the phone's grouped
 * alert reads right without a label of its own.
 */
export function requestNoticeText(
  r: AnsweredRequest,
  answer: RequestAnswer,
  actorName: string,
  timeZone?: string,
): { title: string; body: string } {
  const name = requestName(r);
  if (answer === 'declined') {
    const reply = r.reply?.trim();
    return { title: `Declined: ${name}`, body: reply ? `${actorName} said no: ${reply}` : `${actorName} said no.` };
  }
  if (answer === 'accepted') {
    if (!r.dueAt) return { title: `Accepted: ${name}`, body: `${actorName} said they’ll do it.` };
    const due = r.dueAt.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(timeZone ? { timeZone } : {}),
    });
    return { title: `Accepted: ${name}`, body: `${actorName} will have it done by ${due}.` };
  }
  if (r.category === 'media') {
    return r.issue
      ? { title: `Fixed: ${name}`, body: `${actorName} marked it fixed.` }
      : { title: `Added: ${name}`, body: `${actorName} added it.` };
  }
  if (r.category === 'maintenance') return { title: `Done: ${name}`, body: `${actorName} marked it done.` };
  return {
    title: `Approved: ${name}`,
    body: r.addedToList ? `${actorName} said yes and added it to ${r.addedToList}.` : `${actorName} said yes.`,
  };
}

/** The notice's dedupeKey: one per request, as the unique index needs a key on every row. */
export function requestNoticeKey(requestId: string): string {
  return `request_update:request:${requestId}`;
}

/** Removes the request's answer notice, if any. */
export async function clearRequestNotice(db: Db, householdId: string, requestId: string): Promise<void> {
  await db.notification.deleteMany({ where: { householdId, type: 'request_update', subjectId: requestId } });
}

/**
 * Tells the requester about [answer]: replaces the request's notice with a
 * fresh, unread one. [quiet] (a moved done-by date) only rewrites a notice
 * that's already there, keeping its id and read state, so nothing alerts
 * again. Returns whether a new notice was made.
 */
export async function announceRequestAnswer(
  db: Db,
  householdId: string,
  r: AnsweredRequest,
  answer: RequestAnswer,
  actor: { id: string; name: string },
  opts: { timeZone?: string; quiet?: boolean } = {},
): Promise<boolean> {
  if (r.requesterId === actor.id) return false;
  const text = requestNoticeText(r, answer, actor.name, opts.timeZone);
  if (opts.quiet) {
    await db.notification.updateMany({
      where: { householdId, type: 'request_update', subjectId: r.id },
      data: text,
    });
    return false;
  }
  await clearRequestNotice(db, householdId, r.id);
  await db.notification.create({
    data: {
      householdId,
      userId: r.requesterId,
      type: 'request_update',
      ...text,
      channel: 'in_app',
      subjectType: 'request',
      subjectId: r.id,
      dedupeKey: requestNoticeKey(r.id),
      // Explicit null so unread filters match (see notificationService).
      readAt: null,
    },
  });
  return true;
}
