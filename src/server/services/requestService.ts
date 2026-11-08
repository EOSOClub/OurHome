import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { pushSync } from '@/server/services/pushService';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  plainWriteConflict,
} from '@/server/services/errors';
import { getUserAccess, membersWithAccess } from '@/server/services/permissionService';
import { getPointsSettings } from '@/server/services/pointsService';
import {
  announceRequestAnswer,
  announceRequestNote,
  clearNoteNotices,
  clearRequestNoteNotices,
  clearRequestNotice,
  type RequestAnswer,
} from '@/server/services/requestNoticeService';
import {
  getRequestModules,
  householdMemberIds,
  supervisorsByMember,
} from '@/server/services/requestModuleService';
import { createPreparedShoppingItem, prepareShoppingItem } from '@/server/services/shoppingService';
import { isFeatureEnabled } from '@/server/services/serverAdminService';
import { MEDIA_TYPE_LABELS, type MediaType, type RequestCategory } from '@/lib/enums';
import {
  DECISION_MODULES,
  approveSettings,
  assigneeChoices,
  decidesRequest,
  enabledModules,
  isRequestCategory,
  moduleLabel,
  roleMayAsk,
  type RequestModuleSettings,
} from '@/lib/requestModules';
import type { RequestDTO } from '@/lib/types';
import type {
  AcceptRequestInput,
  AddRequestNoteInput,
  CompleteRequestInput,
  CreateRequestInput,
  DeclineRequestInput,
  ReassignRequestInput,
  UpdateRequestInput,
} from '@/lib/validation/request';

// Household requests. Everyone in the household sees every request of the
// kinds that are on (Settings → Request types, src/lib/requestModules.ts); a
// kind that's turned off keeps its requests but hides them and refuses changes.
//   media:
//                only the requester may edit or delete it. Whoever handles media
//                (the people the head chose, or by default anyone with the
//                Requests "Approve" switch - head and managers) accepts it
//                (the requester sees it's accepted and waiting to be added),
//                then marks it added, which completes it, or declines it,
//                before or after accepting, when the head allows that.
//                Marking a pending one added still works, for app builds from
//                before the accept step. Rows from before statuses existed
//                have no status; treat that as pending. A media request with
//                `issue` reports a problem with something the household
//                already has; it works the same way, and marking it done
//                means fixed.
//   maintenance: the requester asks another member (the assignee), one of the
//                people the head lets be asked. The assignee accepts with a
//                done-by date (`dueAt`, the deadline; optional when the head
//                says so), may move that date, and marks it done, or declines
//                it when the head allows that. The requester may edit or delete
//                it; reassigning sends it back to "pending". The head may also
//                reassign or delete anyone's.
//   purchase, permission:
//                yes or no. Whoever decides (the requester's supervisors, if
//                any, where the head chose that; otherwise the people the
//                head chose or the Approve switch) approves it, which
//                completes it, or declines it. Approving a purchase may put it
//                on a shopping list. The requester may edit it until it's
//                 decided and delete it any time.
// Notes: anyone who works with requests may add a note to any request of a
// kind that's on, open or finished, and everyone reads them. A note counts as
// a change for the Requests badge, and the requester and whoever handles it
// are told (noteRecipients). Its author may remove it, and so may the head;
// removing one doesn't count, and takes its notices with it.

const requestInclude = {
  requester: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
  notes: { include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.RequestInclude;

type RequestWithPeople = Prisma.RequestGetPayload<{
  include: typeof requestInclude;
}>;

export function requestToDTO(r: RequestWithPeople): RequestDTO {
  return {
    id: r.id,
    category: r.category,
    title: r.title,
    mediaType: r.mediaType,
    year: r.year,
    season: r.season,
    issue: r.issue === true,
    episode: r.episode,
    details: r.details,
    url: r.url,
    imageUrl: r.imageUrl,
    price: r.price,
    quantity: r.quantity,
    addedToList: r.addedToList,
    startsAt: r.startsAt?.toISOString() ?? null,
    endsAt: r.endsAt?.toISOString() ?? null,
    assignee: r.assignee ? { id: r.assignee.id, name: r.assignee.name } : null,
    status: r.status,
    dueAt: r.dueAt?.toISOString() ?? null,
    acceptedAt: r.acceptedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    declinedAt: r.declinedAt?.toISOString() ?? null,
    decidedBy: r.decidedBy ? { id: r.decidedBy.id, name: r.decidedBy.name } : null,
    reply: r.reply,
    requester: { id: r.requester.id, name: r.requester.name },
    notes: r.notes.map((n) => ({
      id: n.id,
      body: n.body,
      author: n.author ? { id: n.author.id, name: n.author.name } : null,
      createdAt: n.createdAt.toISOString(),
    })),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * For activity messages, e.g. "the movie “Dune (2021)”", "a problem with
 * season 2, episode 3 of the TV show “Severance (2022)”" or "“Fix the faucet”".
 */
function describe(r: {
  category: string;
  mediaType: string | null;
  title: string;
  year: number | null;
  season?: number | null;
  issue?: boolean | null;
  episode?: number | null;
}): string {
  if (r.category !== 'media') return `“${r.title}”`;
  // Mid-sentence: "Movie" becomes "movie", but "TV show" keeps its capitals.
  const kind = MEDIA_TYPE_LABELS[r.mediaType as MediaType]?.replace(/^[A-Z][a-z]/, (s) => s.toLowerCase()) ?? 'item';
  const name = r.year ? `“${r.title} (${r.year})”` : `“${r.title}”`;
  const part = r.season ? `season ${r.season}${r.episode ? `, episode ${r.episode}` : ''} of ` : '';
  const what = `${part}the ${kind} ${name}`;
  return r.issue ? `a problem with ${what}` : what;
}

/**
 * Wakes the phones of everyone a request change can matter to: the requester,
 * the handler (assignee, or the approve-workflow handlers: the chosen people,
 * the Approve switch holders, and, where they decide, the requester's
 * supervisors), and anyone in `also` (e.g., an assignee it was just taken
 * from). Each phone works out for itself whether to alert, so waking an extra
 * one costs nothing but a quiet re-check, and it clears notifications that
 * went stale on other devices.
 */
async function pushRequestChange(
  householdId: string,
  modules: RequestModuleSettings,
  r: { category: string; requesterId: string; assigneeId: string | null },
  also: (string | null)[] = [],
) {
  const approve = isRequestCategory(r.category) ? approveSettings(modules, r.category) : null;
  const supervisors = approve?.bySupervisors ? await requesterSupervisors(householdId, r.requesterId) : [];
  pushSync(
    householdId,
    {
      userIds: [r.requesterId, r.assigneeId, ...also, ...(approve?.handlerIds ?? []), ...supervisors],
      access: approve ? { page: 'requests', action: 'approve' } : undefined,
    },
    'request',
  );
}

/** A failed lookup only means fewer phones woken; the change itself is saved. */
async function requesterSupervisors(householdId: string, requesterId: string): Promise<string[]> {
  try {
    return (await supervisorsByMember(householdId)).get(requesterId) ?? [];
  } catch (err) {
    console.error('[requests] supervisor lookup for push failed', err);
    return [];
  }
}

/**
 * Tells the requester how their request was answered (requestNoticeService).
 * Call before [pushRequestChange], so their phone finds the notice when it
 * wakes. The actor's name comes from the saved request: whoever decides is
 * `decidedBy`, a maintenance assignee is `assignee`. A failure only means no
 * notice; the answer itself is saved.
 */
async function tellRequester(
  householdId: string,
  request: RequestWithPeople,
  answer: RequestAnswer,
  actorId: string,
  quiet = false,
) {
  try {
    const actor = [request.decidedBy, request.assignee].find((p) => p?.id === actorId);
    const timeZone =
      answer === 'accepted' && request.dueAt ? (await getPointsSettings(householdId)).timezone : undefined;
    await announceRequestAnswer(
      prisma,
      householdId,
      request,
      answer,
      { id: actorId, name: actor?.name ?? 'Someone' },
      { timeZone, quiet },
    );
  } catch (err) {
    console.error('[requests] answer notice failed', err);
  }
}

/** Removes a request's answer notice; a failure leaves a stale bell row, nothing worse. */
async function forgetAnswer(householdId: string, requestId: string) {
  try {
    await clearRequestNotice(prisma, householdId, requestId);
  } catch (err) {
    console.error('[requests] clearing answer notice failed', err);
  }
}

/** Removes a request's note notices; a failure leaves stale bell rows, nothing worse. */
async function forgetNotes(householdId: string, requestId: string) {
  try {
    await clearRequestNoteNotices(prisma, householdId, requestId);
  } catch (err) {
    console.error('[requests] clearing note notices failed', err);
  }
}

/**
 * Who is told about a new note: the requester and whoever handles the
 * request, never its author. Maintenance: the assignee. Media, purchase and
 * permission: whoever accepted or decided it (`decidedById`), or while nobody
 * has, everyone who decides it (as getHandledRequest checks).
 */
async function noteRecipients(
  householdId: string,
  modules: RequestModuleSettings,
  r: { category: string; requesterId: string; assigneeId: string | null; decidedById: string | null },
  authorId: string,
): Promise<string[]> {
  const ids = new Set<string>([r.requesterId]);
  const approve = isRequestCategory(r.category) ? approveSettings(modules, r.category) : null;
  if (!approve) {
    if (r.assigneeId) ids.add(r.assigneeId);
  } else if (r.decidedById) {
    ids.add(r.decidedById);
  } else {
    const [memberIds, approvers, supervisors] = await Promise.all([
      householdMemberIds(householdId),
      membersWithAccess(householdId, 'requests', 'approve'),
      approve.bySupervisors ? supervisorsByMember(householdId) : new Map<string, string[]>(),
    ]);
    const members = new Set(memberIds);
    const holders = new Set(approvers);
    const requesterSupervisorIds = supervisors.get(r.requesterId) ?? [];
    for (const id of memberIds) {
      if (decidesRequest(approve, id, holders.has(id), members, requesterSupervisorIds)) ids.add(id);
    }
  }
  ids.delete(authorId);
  return [...ids];
}

/** For activity messages: "“LEGO set”", "2 × “AA batteries”". */
function describePurchase(r: { title: string; quantity?: number | null }): string {
  return r.quantity && r.quantity > 1 ? `${r.quantity} × “${r.title}”` : `“${r.title}”`;
}

/** Refuses a kind of request the head turned off (or one this server doesn't know). */
function assertModuleOn(modules: RequestModuleSettings, category: string): RequestCategory {
  if (!isRequestCategory(category)) throw new ConflictError('That kind of request isn’t offered here.', 'category');
  if (!enabledModules(modules).includes(category)) {
    throw new ConflictError(`${moduleLabel(modules, category)} requests are turned off in this household.`, 'category');
  }
  return category;
}

/**
 * The household member a maintenance request is assigned to: one of the
 * people the head lets be asked, the requester included when they're one of
 * them (owner, 2026-11-08: whoever may be asked may take on their own
 * request) - unless it's who it's already with (`current`), so a later change
 * to that list doesn't stop the requester editing the rest. `byHead`: the
 * head reassigning, who made that list and may pick anyone.
 */
async function assertAssignable(
  householdId: string,
  modules: RequestModuleSettings,
  assigneeId: string,
  current: string | null = null,
  byHead = false,
) {
  const member = await prisma.user.findFirst({
    where: { id: assigneeId, householdId },
    select: { id: true, name: true },
  });
  if (!member) throw new NotFoundError('That member is not in this household.');
  if (assigneeId !== current && !byHead) {
    const choices = assigneeChoices(modules.maintenance, await householdMemberIds(householdId));
    if (!choices.includes(assigneeId)) {
      throw new ConflictError(
        `${member.name} can’t be asked for ${moduleLabel(modules, 'maintenance').toLowerCase()} requests here.`,
        'assigneeId',
      );
    }
  }
  return member;
}

/**
 * Media: the season (TV only) and the episode (TV problem reports with a
 * season only). `episode` undefined keeps `keepEpisode`, for app builds that
 * don't know about episodes editing a report.
 */
function mediaPlace(
  input: { mediaType: MediaType; season?: number | null; episode?: number | null },
  issue: boolean,
  keepEpisode: number | null = null,
) {
  const season = input.mediaType === 'tv' ? (input.season ?? null) : null;
  const episode = issue && season !== null ? (input.episode === undefined ? keepEpisode : input.episode) : null;
  return { season, episode };
}

/** Media: the kind must be among those the head offers, unless it's the request's own kind already. */
function assertMediaTypeOffered(modules: RequestModuleSettings, mediaType: MediaType, current: string | null = null) {
  if (mediaType !== current && !modules.media.mediaTypes.includes(mediaType)) {
    throw new ConflictError(`${MEDIA_TYPE_LABELS[mediaType]} requests aren’t offered here.`, 'mediaType');
  }
}

export async function listRequests(householdId: string): Promise<RequestWithPeople[]> {
  const [modules, rows] = await Promise.all([
    getRequestModules(householdId),
    prisma.request.findMany({
      where: { householdId },
      include: requestInclude,
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  // Filtered here rather than in the query: the oldest rows may have no
  // stored category (Prisma reads them as the default, "media").
  const on = new Set<string>(enabledModules(modules));
  return rows.filter((r) => on.has(r.category));
}

/**
 * The Requests badge: requests someone else made or changed since `userId`
 * last opened Requests (website or app, see markRequestsSeen). Rows untouched
 * since the badge was added have no `changedById` and never count; neither do
 * kinds that are off, which aren't listed.
 */
export async function countNewRequests(householdId: string, userId: string): Promise<number> {
  const [modules, me] = await Promise.all([
    getRequestModules(householdId),
    prisma.user.findUnique({ where: { id: userId }, select: { requestsSeenAt: true } }),
  ]);
  const on = new Set<string>(enabledModules(modules));
  if (on.size === 0) return 0;
  const rows = await prisma.request.findMany({
    where: { householdId, ...(me?.requestsSeenAt ? { updatedAt: { gt: me.requestsSeenAt } } : {}) },
    select: { category: true, changedById: true },
  });
  return rows.filter((r) => on.has(r.category) && r.changedById != null && r.changedById !== userId).length;
}

/** They opened Requests: the badge counts from now. */
export async function markRequestsSeen(userId: string, now: Date = new Date()) {
  await prisma.user.update({ where: { id: userId }, data: { requestsSeenAt: now } });
}

export interface RequestActor {
  id: string;
  role: string;
}

export async function createRequest(
  householdId: string,
  actor: RequestActor,
  input: CreateRequestInput,
): Promise<RequestWithPeople> {
  const modules = await getRequestModules(householdId);
  const category = assertModuleOn(modules, input.category);
  if (!roleMayAsk(modules[category], actor.role)) {
    throw new ForbiddenError(`You can’t make ${moduleLabel(modules, category).toLowerCase()} requests.`, 'category');
  }

  let request: RequestWithPeople;
  let message: string;

  if (input.category === 'media') {
    assertMediaTypeOffered(modules, input.mediaType);
    const issue = input.issue === true;
    request = await prisma.request.create({
      data: {
        householdId,
        requesterId: actor.id,
        changedById: actor.id,
        category: 'media',
        mediaType: input.mediaType,
        title: input.title,
        year: input.year,
        ...mediaPlace(input, issue),
        issue,
        details: issue ? (input.details ?? null) : null,
        status: 'pending',
      },
      include: requestInclude,
    });
    message = issue ? `reported ${describe(request)}` : `requested ${describe(request)}`;
  } else if (input.category === 'purchase') {
    request = await prisma.request.create({
      data: {
        householdId,
        requesterId: actor.id,
        changedById: actor.id,
        category: 'purchase',
        title: input.title,
        details: input.details ?? null,
        url: input.url ?? null,
        imageUrl: input.imageUrl ?? null,
        price: input.price ?? null,
        quantity: input.quantity ?? null,
        status: 'pending',
      },
      include: requestInclude,
    });
    message = `asked to buy ${describePurchase(request)}`;
  } else if (input.category === 'permission') {
    request = await prisma.request.create({
      data: {
        householdId,
        requesterId: actor.id,
        changedById: actor.id,
        category: 'permission',
        title: input.title,
        details: input.details ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.startsAt ? (input.endsAt ?? null) : null,
        status: 'pending',
      },
      include: requestInclude,
    });
    message = `asked permission for ${describe(request)}`;
  } else {
    const assignee = await assertAssignable(householdId, modules, input.assigneeId);
    request = await prisma.request.create({
      data: {
        householdId,
        requesterId: actor.id,
        changedById: actor.id,
        category: 'maintenance',
        title: input.title,
        details: input.details ?? null,
        assigneeId: assignee.id,
        status: 'pending',
      },
      include: requestInclude,
    });
    message =
      assignee.id === actor.id
        ? `took on ${describe(request)} themselves`
        : `asked ${assignee.name} to handle ${describe(request)}`;
  }

  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'created',
    subjectType: 'request',
    subjectId: request.id,
    message,
  });
  await pushRequestChange(householdId, modules, request);

  return request;
}

async function getRequest(householdId: string, id: string) {
  const existing = await prisma.request.findFirst({ where: { id, householdId } });
  if (!existing) throw new NotFoundError('Request not found.');
  return existing;
}

async function getOwnRequest(householdId: string, id: string, userId: string) {
  const existing = await getRequest(householdId, id);
  if (existing.requesterId !== userId) {
    throw new ForbiddenError('You can only change your own requests.');
  }
  return existing;
}

/**
 * Loads a request the actor is the handler for: approve workflow (media,
 * purchase, permission) → one of the people who decide it (Settings → Request
 * types: the requester's supervisors where the head chose that, else the
 * chosen people or by default the Requests "Approve" switch); maintenance →
 * the assignee. The kind must be on.
 */
async function getHandledRequest(
  householdId: string,
  modules: RequestModuleSettings,
  id: string,
  actor: RequestActor,
) {
  const existing = await getRequest(householdId, id);
  const category = assertModuleOn(modules, existing.category);
  const approve = approveSettings(modules, category);
  if (approve) {
    const [access, memberIds, supervisors] = await Promise.all([
      getUserAccess({ id: actor.id, householdId }),
      householdMemberIds(householdId),
      approve.bySupervisors ? supervisorsByMember(householdId) : new Map<string, string[]>(),
    ]);
    const members = new Set(memberIds);
    const requesterSupervisorIds = supervisors.get(existing.requesterId) ?? [];
    if (!decidesRequest(approve, actor.id, access.requests.approve, members, requesterSupervisorIds)) {
      if (category === 'media') throw new ForbiddenError("You can't accept or add media requests.");
      throw new ForbiddenError(
        approve.bySupervisors && requesterSupervisorIds.some((s) => members.has(s))
          ? 'Only their supervisors can decide this.'
          : 'You can’t decide this request.',
      );
    }
  } else if (existing.assigneeId !== actor.id) {
    throw new ForbiddenError('Only the person this was assigned to can do that.');
  }
  return existing;
}

function assertStillOpen(existing: { status: string | null }) {
  if (existing.status === 'completed') {
    throw new ConflictError('This request is already done.');
  }
  if (existing.status === 'declined') {
    throw new ConflictError('This request was declined.');
  }
}

export async function updateRequest(
  householdId: string,
  userId: string,
  input: UpdateRequestInput,
): Promise<RequestWithPeople> {
  const modules = await getRequestModules(householdId);
  const existing = await getOwnRequest(householdId, input.id, userId);
  if (existing.category !== input.category) {
    throw new ConflictError("A request's category can't be changed.");
  }
  assertModuleOn(modules, existing.category);
  if (existing.status === 'declined') {
    throw new ConflictError('This request was declined. Remove it, and ask again if something changed.');
  }
  // A yes covers what was asked; a changed request needs a new one.
  if (existing.status === 'completed' && (DECISION_MODULES as readonly string[]).includes(existing.category)) {
    throw new ConflictError('This request was already approved. Ask again if something changed.');
  }

  let data: Prisma.RequestUpdateInput;
  if (input.category === 'purchase') {
    data = {
      title: input.title,
      details: input.details ?? null,
      url: input.url ?? null,
      imageUrl: input.imageUrl ?? null,
      price: input.price ?? null,
      quantity: input.quantity ?? null,
    };
  } else if (input.category === 'permission') {
    data = {
      title: input.title,
      details: input.details ?? null,
      startsAt: input.startsAt ?? null,
      endsAt: input.startsAt ? (input.endsAt ?? null) : null,
    };
  } else if (input.category === 'media') {
    assertMediaTypeOffered(modules, input.mediaType, existing.mediaType);
    // A problem report stays one (and a request to add stays that); app
    // builds that don't know about reports send no description, so keep it.
    const issue = existing.issue === true;
    data = {
      mediaType: input.mediaType,
      title: input.title,
      year: input.year,
      ...mediaPlace(input, issue, existing.episode),
      details: issue ? (input.details || existing.details) : null,
    };
  } else {
    const reassigned = input.assigneeId !== existing.assigneeId;
    // A new assignee would reopen a finished job and lose when it was done;
    // the head can't reassign a finished one either. Its text may still change.
    if (reassigned && existing.status === 'completed') {
      throw new ConflictError('This request is already done, so it can’t go to someone else. Ask again if it needs doing again.', 'assigneeId');
    }
    await assertAssignable(householdId, modules, input.assigneeId, existing.assigneeId);
    data = {
      title: input.title,
      details: input.details ?? null,
      assignee: { connect: { id: input.assigneeId } },
      // A new assignee hasn't agreed to anything yet.
      ...(reassigned
        ? { status: 'pending', dueAt: null, acceptedAt: null, completedAt: null }
        : {}),
    };
  }

  const request = await prisma.request.update({
    where: { id: input.id },
    data: { ...data, changedById: userId },
    include: requestInclude,
  });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'updated',
    subjectType: 'request',
    subjectId: request.id,
    message: `updated their ${request.issue ? 'report of' : 'request'} ${
      request.category === 'purchase' ? `to buy ${describePurchase(request)}` : describe(request)
    }`,
  });
  // Reassigned: the old assignee's "Accepted" no longer holds.
  if (request.assigneeId !== existing.assigneeId) await forgetAnswer(householdId, request.id);
  // `existing.assigneeId`: a reassigned request leaves the old assignee's list.
  await pushRequestChange(householdId, modules, request, [existing.assigneeId]);

  return request;
}

/**
 * Maintenance: the head gives an open request to another member, anyone,
 * the requester included (the list of people who may be asked doesn't bind
 * the head, since the head set it).
 * Like the requester reassigning, it goes back to "pending" for the new person.
 */
export async function reassignRequest(
  householdId: string,
  actor: RequestActor,
  input: ReassignRequestInput,
): Promise<RequestWithPeople> {
  const modules = await getRequestModules(householdId);
  const existing = await getRequest(householdId, input.id);
  if (existing.category !== 'maintenance') {
    throw new ConflictError('Only maintenance requests go to a person.');
  }
  assertModuleOn(modules, existing.category);
  if (actor.role !== 'head') throw new ForbiddenError('Only the Head of House can reassign requests.');
  assertStillOpen(existing);
  if (input.assigneeId === existing.assigneeId) {
    throw new ConflictError('It’s already with them.', 'assigneeId');
  }
  const assignee = await assertAssignable(householdId, modules, input.assigneeId, existing.assigneeId, true);

  const request = await prisma.request.update({
    where: { id: input.id },
    data: {
      assignee: { connect: { id: assignee.id } },
      // A new assignee hasn't agreed to anything yet.
      status: 'pending',
      dueAt: null,
      acceptedAt: null,
      completedAt: null,
      changedById: actor.id,
    },
    include: requestInclude,
  });

  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'updated',
    subjectType: 'request',
    subjectId: request.id,
    message: `gave ${describe(request)} to ${assignee.name}`,
  });
  // The old assignee's "Accepted" no longer holds.
  await forgetAnswer(householdId, request.id);
  // `existing.assigneeId`: it leaves the old assignee's list.
  await pushRequestChange(householdId, modules, request, [existing.assigneeId]);

  return request;
}

/**
 * Maintenance: the assignee accepts, committing to (or moving) a done-by date
 * - the deadline. When the head made the date optional, accepting without one
 * is fine too (and saving no date clears it). Media: a handler accepts it (no
 * date), and marks it added later. Purchase and permission have no step for
 * accepting; old app builds that call this for them approve instead.
 */
export async function acceptRequest(
  householdId: string,
  actor: RequestActor,
  input: AcceptRequestInput,
): Promise<RequestWithPeople> {
  const modules = await getRequestModules(householdId);
  const existing = await getHandledRequest(householdId, modules, input.id, actor);
  assertStillOpen(existing);
  if (existing.category === 'media') return acceptMedia(householdId, modules, existing, actor);
  if (isRequestCategory(existing.category) && approveSettings(modules, existing.category)) {
    return completeRequest(householdId, actor, { id: input.id });
  }
  if (!input.dueAt && modules.maintenance.requireDueDate) {
    throw new ConflictError("Pick the date you'll have it done by.", 'dueAt');
  }
  const rescheduling = existing.status === 'accepted';

  // Claimed from the status read, like approve and decline: an accept that
  // overlaps a "mark done" or a decline must not reopen the request.
  const request = await answerTransaction(async (tx) => {
    await claimAnswer(tx, existing, 'accepted', actor.id);
    return tx.request.update({
      where: { id: input.id },
      data: {
        status: 'accepted',
        dueAt: input.dueAt ?? null,
        acceptedAt: existing.acceptedAt ?? new Date(),
        changedById: actor.id,
      },
      include: requestInclude,
    });
  });

  let message: string;
  if (input.dueAt) {
    // The household's day, not the server's (UTC in Docker): a date picked as
    // noon Chicago is fine either way, but a done-by time late in the
    // evening read as the next day in Activity.
    const { timezone } = await getPointsSettings(householdId);
    const when = input.dueAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: timezone });
    message = rescheduling
      ? `moved ${describe(request)} to ${when}`
      : `accepted ${describe(request)}, done by ${when}`;
  } else {
    message = rescheduling ? `took the done-by date off ${describe(request)}` : `accepted ${describe(request)}`;
  }
  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'updated',
    subjectType: 'request',
    subjectId: request.id,
    message,
  });
  // A moved date rewrites the notice they already have instead of alerting again.
  await tellRequester(householdId, request, 'accepted', actor.id, rescheduling);
  await pushRequestChange(householdId, modules, request);

  return request;
}

/**
 * Media: a handler takes it on. The requester is told it's accepted and
 * waiting to be added (or fixed); `decidedBy` names who accepted it until
 * someone marks it added or declines it.
 */
async function acceptMedia(
  householdId: string,
  modules: RequestModuleSettings,
  existing: { id: string; householdId: string; status: string | null },
  actor: RequestActor,
): Promise<RequestWithPeople> {
  if (existing.status === 'accepted') throw new ConflictError('This request is already accepted.');
  // Claimed from the status read: an accept that overlaps a "mark added" or a
  // decline must not turn the request back to accepted.
  const request = await answerTransaction(async (tx) => {
    await claimAnswer(tx, existing, 'accepted', actor.id);
    return tx.request.update({
      where: { id: existing.id },
      data: {
        status: 'accepted',
        acceptedAt: new Date(),
        decidedBy: { connect: { id: actor.id } },
        changedById: actor.id,
      },
      include: requestInclude,
    });
  });
  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'updated',
    subjectType: 'request',
    subjectId: request.id,
    message: request.issue ? `took on ${describe(request)}` : `accepted ${describe(request)}`,
  });
  await tellRequester(householdId, request, 'accepted', actor.id);
  await pushRequestChange(householdId, modules, request);
  return request;
}

/**
 * Purchase approved with a list: checks and prepares putting it on that
 * shopping list as the approver, who needs Shopping "Add" (and the Shopping
 * feature on). Returns the list's name and the item, which completeRequest
 * writes once the approval itself is in.
 */
async function preparePurchaseForList(
  householdId: string,
  actor: RequestActor,
  r: { title: string; quantity: number | null; url: string | null; imageUrl: string | null; price: number | null; requesterId: string },
  listId: string,
) {
  const [access, shoppingOn, requester] = await Promise.all([
    getUserAccess({ id: actor.id, householdId }),
    isFeatureEnabled(householdId, 'shopping'),
    prisma.user.findUnique({ where: { id: r.requesterId }, select: { name: true } }),
  ]);
  if (!shoppingOn || !access.shopping.create) {
    throw new ForbiddenError('You can’t add to shopping lists, so approve it without a list.', 'listId');
  }
  const list = await prisma.shoppingList.findFirst({ where: { id: listId, householdId }, select: { name: true } });
  if (!list) throw new NotFoundError('That shopping list is gone. Pick another one.');
  const item = await prepareShoppingItem(householdId, {
    listId,
    name: r.title,
    quantity: r.quantity ?? 1,
    priority: 'medium',
    notes: requester ? `Requested by ${requester.name}` : null,
    url: r.url,
    imageUrl: r.imageUrl,
    estimatedPrice: r.price,
    recurring: false,
    categoryId: null,
  });
  return { listName: list.name, item };
}

/**
 * Moves a request on from the status it was read in, or refuses. Two answers
 * at once (two deciders, a double tap, an app retry) both pass the checks on
 * the read; only the first may count, so a purchase can't go on the shopping
 * list twice, or end declined with its item already on the list.
 */
const JUST_CHANGED = 'This request just changed. Refresh to see where it stands.';

/**
 * The transaction an answer runs in. Two answers at exactly the same moment
 * can also end in a database write conflict instead of claimAnswer's count of
 * 0; that's the same situation, so it gets the same message, not a 500.
 */
function answerTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return plainWriteConflict(() => prisma.$transaction(fn), JUST_CHANGED);
}

async function claimAnswer(
  tx: Prisma.TransactionClient,
  existing: { id: string; householdId: string; status: string | null },
  status: 'accepted' | 'completed' | 'declined',
  actorId: string,
) {
  const { count } = await tx.request.updateMany({
    where: {
      id: existing.id,
      householdId: existing.householdId,
      // Old media requests have no status at all.
      ...(existing.status
        ? { status: existing.status }
        : { OR: [{ status: null }, { status: { isSet: false } }] }),
    },
    data: { status, changedById: actorId },
  });
  if (count === 0) {
    throw new ConflictError(JUST_CHANGED);
  }
}

/**
 * Maintenance: the assignee marks it done. Media: a handler marks it added
 * (normally once accepted; a pending one too, for app builds from before the
 * accept step). Purchase and permission: whoever decides approves it; a purchase with
 * `listId` also goes on that shopping list.
 */
export async function completeRequest(
  householdId: string,
  actor: RequestActor,
  input: CompleteRequestInput,
): Promise<RequestWithPeople> {
  const { id } = input;
  const modules = await getRequestModules(householdId);
  const existing = await getHandledRequest(householdId, modules, id, actor);
  assertStillOpen(existing);
  const approve = isRequestCategory(existing.category) && approveSettings(modules, existing.category) !== null;
  // The list checked first: if that's refused, nothing is approved yet.
  const purchase =
    existing.category === 'purchase' && input.listId
      ? await preparePurchaseForList(householdId, actor, existing, input.listId)
      : null;
  const addedToList = purchase?.listName ?? null;

  const request = await answerTransaction(async (tx) => {
    await claimAnswer(tx, existing, 'completed', actor.id);
    // On the list only once this answer is the one that counts.
    if (purchase) await createPreparedShoppingItem(householdId, actor.id, purchase.item, tx);
    return tx.request.update({
      where: { id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        ...(approve ? { decidedBy: { connect: { id: actor.id } } } : {}),
        ...(addedToList ? { addedToList } : {}),
        changedById: actor.id,
      },
      include: requestInclude,
    });
  });

  let message: string;
  if (request.category === 'purchase') {
    message = `approved buying ${describePurchase(request)}${addedToList ? ` and added it to ${addedToList}` : ''}`;
  } else if (request.category === 'permission') {
    message = `approved ${describe(request)}`;
  } else if (request.issue) {
    message = `fixed ${describe(request)}`;
  } else {
    message = approve ? `added ${describe(request)}` : `finished ${describe(request)}`;
  }
  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'completed',
    subjectType: 'request',
    subjectId: request.id,
    message,
  });
  await tellRequester(householdId, request, approve ? 'approved' : 'done', actor.id);
  await pushRequestChange(householdId, modules, request);

  return request;
}

/**
 * Requests whose module allows it (Settings → Request types; always for
 * purchase and permission): whoever decides (approve workflow) or the person
 * asked (maintenance, before or after accepting) says no, with an
 * optional reason for the requester. Final: the requester may remove it, not
 * edit it.
 */
export async function declineRequest(
  householdId: string,
  actor: RequestActor,
  input: DeclineRequestInput,
): Promise<RequestWithPeople> {
  const modules = await getRequestModules(householdId);
  const existing = await getHandledRequest(householdId, modules, input.id, actor);
  if (!isRequestCategory(existing.category) || !modules[existing.category].allowDecline) {
    throw new ConflictError('Requests like this can’t be declined here.');
  }
  assertStillOpen(existing);

  const request = await answerTransaction(async (tx) => {
    await claimAnswer(tx, existing, 'declined', actor.id);
    return tx.request.update({
      where: { id: input.id },
      data: {
        status: 'declined',
        declinedAt: new Date(),
        decidedBy: { connect: { id: actor.id } },
        reply: input.reply,
        changedById: actor.id,
      },
      include: requestInclude,
    });
  });

  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'updated',
    subjectType: 'request',
    subjectId: request.id,
    message: request.issue
      ? `declined the report of ${describe(request)}`
      : request.category === 'purchase'
        ? `declined buying ${describePurchase(request)}`
        : `declined ${describe(request)}`,
  });
  await tellRequester(householdId, request, 'declined', actor.id);
  await pushRequestChange(householdId, modules, request);

  return request;
}

/** The requester removes their own request; the head may also remove anyone's maintenance request. */
export async function deleteRequest(
  householdId: string,
  actor: RequestActor,
  id: string,
): Promise<void> {
  const existing = await getRequest(householdId, id);
  const own = existing.requesterId === actor.id;
  if (!own && !(actor.role === 'head' && existing.category === 'maintenance')) {
    throw new ForbiddenError('You can only change your own requests.');
  }
  const requester = own
    ? null
    : await prisma.user.findUnique({ where: { id: existing.requesterId }, select: { name: true } });
  await prisma.request.delete({ where: { id } });
  await forgetAnswer(householdId, id);
  await forgetNotes(householdId, id);

  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'deleted',
    subjectType: 'request',
    subjectId: id,
    message: own
      ? `withdrew their ${existing.issue ? 'report of' : 'request'} ${
          existing.category === 'purchase' ? `to buy ${describePurchase(existing)}` : describe(existing)
        }`
      : `removed ${requester ? `${requester.name}’s` : 'a'} request ${describe(existing)}`,
  });
  await pushRequestChange(householdId, await getRequestModules(householdId), existing);
}

/**
 * Anyone who works with requests adds a note to a request of a kind that's
 * on, open or finished, for the whole household to read. It counts as a
 * change (`changedById`), so the Requests badge shows it to everyone else,
 * and the requester and whoever handles it are told (noteRecipients).
 */
export async function addRequestNote(
  householdId: string,
  actor: RequestActor,
  input: AddRequestNoteInput,
): Promise<RequestWithPeople> {
  const modules = await getRequestModules(householdId);
  const existing = await getRequest(householdId, input.id);
  assertModuleOn(modules, existing.category);

  const note = await prisma.requestNote.create({
    data: { householdId, requestId: existing.id, authorId: actor.id, body: input.body },
  });
  const request = await prisma.request.update({
    where: { id: existing.id },
    data: { changedById: actor.id },
    include: requestInclude,
  });

  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'updated',
    subjectType: 'request',
    subjectId: request.id,
    message: `added a note to ${request.category === 'purchase' ? describePurchase(request) : describe(request)}`,
  });
  // Before the push, so their phones find the notice when they wake.
  let told: string[] = [];
  try {
    told = await noteRecipients(householdId, modules, request, actor.id);
    const name = request.notes.find((n) => n.id === note.id)?.author?.name ?? 'Someone';
    await announceRequestNote(prisma, householdId, request, note, { id: actor.id, name }, told);
  } catch (err) {
    // No notice, nothing worse: the note itself is saved.
    console.error('[requests] note notice failed', err);
  }
  await pushRequestChange(householdId, modules, request, told);

  return request;
}

/** Its author removes a note, or the head removes anyone's. Returns the request without it. */
export async function deleteRequestNote(
  householdId: string,
  actor: RequestActor,
  noteId: string,
): Promise<RequestWithPeople> {
  const note = await prisma.requestNote.findFirst({ where: { id: noteId, householdId } });
  if (!note) throw new NotFoundError('Note not found.');
  if (note.authorId !== actor.id && actor.role !== 'head') {
    throw new ForbiddenError('You can only remove your own notes.');
  }
  const modules = await getRequestModules(householdId);
  const existing = await getRequest(householdId, note.requestId);
  assertModuleOn(modules, existing.category);

  await prisma.requestNote.delete({ where: { id: note.id } });
  try {
    await clearNoteNotices(prisma, householdId, note.id);
  } catch (err) {
    console.error('[requests] clearing note notices failed', err);
  }
  const request = await prisma.request.findFirstOrThrow({
    where: { id: existing.id, householdId },
    include: requestInclude,
  });
  await pushRequestChange(householdId, modules, request);

  return request;
}
