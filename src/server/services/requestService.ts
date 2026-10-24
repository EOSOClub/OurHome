import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { pushSync } from '@/server/services/pushService';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@/server/services/errors';
import { getUserAccess } from '@/server/services/permissionService';
import { getPointsSettings } from '@/server/services/pointsService';
import {
  announceRequestAnswer,
  clearRequestNotice,
  type RequestAnswer,
} from '@/server/services/requestNoticeService';
import {
  getRequestModules,
  householdMemberIds,
  supervisorsByMember,
} from '@/server/services/requestModuleService';
import { addShoppingItem } from '@/server/services/shoppingService';
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
  CompleteRequestInput,
  CreateRequestInput,
  DeclineRequestInput,
  UpdateRequestInput,
} from '@/lib/validation/request';

// Household requests. Everyone in the household sees every request of the
// kinds that are on (Settings → Request types, src/lib/requestModules.ts); a
// kind that's turned off keeps its requests but hides them and refuses changes.
//   media:       only the requester may edit or delete it. Whoever handles media
//                (the people the head chose, or by default anyone with the
//                Requests "Approve" switch - head and managers) marks it added,
//                which completes it, or declines it when the head allows that.
//                Rows from before statuses existed have no status; treat that
//                as pending. "accepted" rows from the older accept → available
//                flow still count as waiting. A media request with `issue`
//                reports a problem with something the household already has;
//                it works the same way, and marking it done means fixed.
//   maintenance: the requester asks another member (the assignee), one of the
//                people the head lets be asked. The assignee accepts with a
//                done-by date (`dueAt`, the deadline; optional when the head
//                says so), may move that date, and marks it done, or declines
//                it when the head allows that. The requester may edit or delete
//                it; reassigning sends it back to "pending".
//   purchase,    yes or no. Whoever decides (the requester's supervisors where
//   permission:  the head chose that and they have any, otherwise the people
//                the head chose or the Approve switch) approves it, which
//                completes it, or declines it. Approving a purchase may put it
//                on a shopping list. The requester may edit it until it's
//                decided, and delete it any time.

const requestInclude = {
  requester: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
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
 * the Approve switch holders and, where they decide, the requester's
 * supervisors), and anyone in `also` (e.g. an assignee it was just taken
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
 * The household member a maintenance request is assigned to: never the
 * requester, and one of the people the head lets be asked - unless it's who
 * it's already with (`current`), so a later change to that list doesn't stop
 * the requester editing the rest.
 */
async function assertAssignable(
  householdId: string,
  modules: RequestModuleSettings,
  assigneeId: string,
  requesterId: string,
  current: string | null = null,
) {
  if (assigneeId === requesterId) {
    throw new ConflictError('Choose someone else to do it.', 'assigneeId');
  }
  const member = await prisma.user.findFirst({
    where: { id: assigneeId, householdId },
    select: { id: true, name: true },
  });
  if (!member) throw new NotFoundError('That member is not in this household.');
  if (assigneeId !== current) {
    const choices = assigneeChoices(modules.maintenance, await householdMemberIds(householdId), requesterId);
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

/** Media: the kind must be one the head offers, unless it's the request's own kind already. */
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
    const assignee = await assertAssignable(householdId, modules, input.assigneeId, actor.id);
    request = await prisma.request.create({
      data: {
        householdId,
        requesterId: actor.id,
        category: 'maintenance',
        title: input.title,
        details: input.details ?? null,
        assigneeId: assignee.id,
        status: 'pending',
      },
      include: requestInclude,
    });
    message = `asked ${assignee.name} to handle ${describe(request)}`;
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
      if (category === 'media') throw new ForbiddenError("You can't mark media requests added.");
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
    await assertAssignable(householdId, modules, input.assigneeId, userId, existing.assigneeId);
    const reassigned = input.assigneeId !== existing.assigneeId;
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
    data,
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
 * Maintenance: the assignee accepts, committing to (or moving) a done-by date
 * - the deadline. When the head made the date optional, accepting without one
 * is fine too (and saving no date clears it). The approve workflow has no
 * accept step; app builds from before the one-step media flow still call this,
 * so it marks the request done instead.
 */
export async function acceptRequest(
  householdId: string,
  actor: RequestActor,
  input: AcceptRequestInput,
): Promise<RequestWithPeople> {
  const modules = await getRequestModules(householdId);
  const existing = await getHandledRequest(householdId, modules, input.id, actor);
  assertStillOpen(existing);
  if (isRequestCategory(existing.category) && approveSettings(modules, existing.category)) {
    return completeRequest(householdId, actor, { id: input.id });
  }
  if (!input.dueAt && modules.maintenance.requireDueDate) {
    throw new ConflictError("Pick the date you'll have it done by.", 'dueAt');
  }
  const rescheduling = existing.status === 'accepted';

  const request = await prisma.request.update({
    where: { id: input.id },
    data: {
      status: 'accepted',
      dueAt: input.dueAt ?? null,
      acceptedAt: existing.acceptedAt ?? new Date(),
    },
    include: requestInclude,
  });

  let message: string;
  if (input.dueAt) {
    const when = input.dueAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
 * Purchase approved with a list: puts it on that shopping list as the
 * approver, who needs Shopping "Add" (and the Shopping feature on). Returns
 * the list's name.
 */
async function addPurchaseToList(
  householdId: string,
  actor: RequestActor,
  r: { title: string; quantity: number | null; url: string | null; imageUrl: string | null; price: number | null; requesterId: string },
  listId: string,
): Promise<string> {
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
  await addShoppingItem(householdId, actor.id, {
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
  return list.name;
}

/**
 * Maintenance: the assignee marks it done. Media: a handler marks it added.
 * Purchase and permission: whoever decides approves it; a purchase with
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
  // On the list first: if that's refused, nothing is approved yet.
  const addedToList =
    existing.category === 'purchase' && input.listId
      ? await addPurchaseToList(householdId, actor, existing, input.listId)
      : null;

  const request = await prisma.request.update({
    where: { id },
    data: {
      status: 'completed',
      completedAt: new Date(),
      ...(approve ? { decidedBy: { connect: { id: actor.id } } } : {}),
      ...(addedToList ? { addedToList } : {}),
    },
    include: requestInclude,
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

  const request = await prisma.request.update({
    where: { id: input.id },
    data: {
      status: 'declined',
      declinedAt: new Date(),
      decidedBy: { connect: { id: actor.id } },
      reply: input.reply,
    },
    include: requestInclude,
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

export async function deleteRequest(
  householdId: string,
  userId: string,
  id: string,
): Promise<void> {
  const existing = await getOwnRequest(householdId, id, userId);
  await prisma.request.delete({ where: { id } });
  await forgetAnswer(householdId, id);

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'deleted',
    subjectType: 'request',
    subjectId: id,
    message: `withdrew their ${existing.issue ? 'report of' : 'request'} ${
      existing.category === 'purchase' ? `to buy ${describePurchase(existing)}` : describe(existing)
    }`,
  });
  await pushRequestChange(householdId, await getRequestModules(householdId), existing);
}
