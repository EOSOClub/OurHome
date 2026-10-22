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
import { getRequestModules, householdMemberIds } from '@/server/services/requestModuleService';
import { MEDIA_TYPE_LABELS, type MediaType, type RequestCategory } from '@/lib/enums';
import {
  approveSettings,
  assigneeChoices,
  enabledModules,
  handlesApproval,
  isRequestCategory,
  moduleLabel,
  roleMayAsk,
  type RequestModuleSettings,
} from '@/lib/requestModules';
import type { RequestDTO } from '@/lib/types';
import type {
  AcceptRequestInput,
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
//                flow still count as waiting.
//   maintenance: the requester asks another member (the assignee), one of the
//                people the head lets be asked. The assignee accepts with a
//                done-by date (`dueAt`, the deadline; optional when the head
//                says so), may move that date, and marks it done, or declines
//                it when the head allows that. The requester may edit or delete
//                it; reassigning sends it back to "pending".

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
    details: r.details,
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

/** For activity messages, e.g. "the movie “Dune (2021)”" or "“Fix the faucet”". */
function describe(r: {
  category: string;
  mediaType: string | null;
  title: string;
  year: number | null;
  season?: number | null;
}): string {
  if (r.category !== 'media') return `“${r.title}”`;
  const kind = MEDIA_TYPE_LABELS[r.mediaType as MediaType]?.toLowerCase() ?? 'item';
  const name = r.year ? `“${r.title} (${r.year})”` : `“${r.title}”`;
  return r.season ? `season ${r.season} of the ${kind} ${name}` : `the ${kind} ${name}`;
}

/**
 * Wakes the phones of everyone a request change can matter to: the requester,
 * the handler (assignee, or the media handlers: the chosen people and the
 * Approve switch holders), and anyone in `also` (e.g. an assignee it was just
 * taken from). Each phone works out for itself whether to alert, so waking an
 * extra one costs nothing but a quiet re-check, and it clears notifications
 * that went stale on other devices.
 */
function pushRequestChange(
  householdId: string,
  modules: RequestModuleSettings,
  r: { category: string; requesterId: string; assigneeId: string | null },
  also: (string | null)[] = [],
) {
  const approve = isRequestCategory(r.category) ? approveSettings(modules, r.category) : null;
  pushSync(
    householdId,
    {
      userIds: [r.requesterId, r.assigneeId, ...also, ...(approve?.handlerIds ?? [])],
      access: approve ? { page: 'requests', action: 'approve' } : undefined,
    },
    'request',
  );
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
    request = await prisma.request.create({
      data: {
        householdId,
        requesterId: actor.id,
        category: 'media',
        mediaType: input.mediaType,
        title: input.title,
        year: input.year,
        season: input.mediaType === 'tv' ? (input.season ?? null) : null,
        status: 'pending',
      },
      include: requestInclude,
    });
    message = `requested ${describe(request)}`;
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
  pushRequestChange(householdId, modules, request);

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
 * Loads a request the actor is the handler for: media → one of the people who
 * handle media (Settings → Request types, by default the Requests "Approve"
 * switch); maintenance → the assignee. The kind must be on.
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
    const [access, memberIds] = await Promise.all([
      getUserAccess({ id: actor.id, householdId }),
      householdMemberIds(householdId),
    ]);
    if (!handlesApproval(approve, actor.id, access.requests.approve, new Set(memberIds))) {
      throw new ForbiddenError("You can't mark media requests added.");
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

  let data: Prisma.RequestUpdateInput;
  if (input.category === 'media') {
    assertMediaTypeOffered(modules, input.mediaType, existing.mediaType);
    data = {
      mediaType: input.mediaType,
      title: input.title,
      year: input.year,
      season: input.mediaType === 'tv' ? (input.season ?? null) : null,
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
    message: `updated their request ${describe(request)}`,
  });
  // `existing.assigneeId`: a reassigned request leaves the old assignee's list.
  pushRequestChange(householdId, modules, request, [existing.assigneeId]);

  return request;
}

/**
 * Maintenance: the assignee accepts, committing to (or moving) a done-by date
 * - the deadline. When the head made the date optional, accepting without one
 * is fine too (and saving no date clears it). Media has no accept step any
 * more; app builds from before the one-step flow still call this, so it marks
 * the request added instead.
 */
export async function acceptRequest(
  householdId: string,
  actor: RequestActor,
  input: AcceptRequestInput,
): Promise<RequestWithPeople> {
  const modules = await getRequestModules(householdId);
  const existing = await getHandledRequest(householdId, modules, input.id, actor);
  assertStillOpen(existing);
  if (existing.category === 'media') return completeRequest(householdId, actor, input.id);
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
  pushRequestChange(householdId, modules, request);

  return request;
}

/** Maintenance: the assignee marks it done. Media: a handler marks it added. */
export async function completeRequest(
  householdId: string,
  actor: RequestActor,
  id: string,
): Promise<RequestWithPeople> {
  const modules = await getRequestModules(householdId);
  const existing = await getHandledRequest(householdId, modules, id, actor);
  assertStillOpen(existing);
  const approve = isRequestCategory(existing.category) && approveSettings(modules, existing.category) !== null;

  const request = await prisma.request.update({
    where: { id },
    data: {
      status: 'completed',
      completedAt: new Date(),
      ...(approve ? { decidedBy: { connect: { id: actor.id } } } : {}),
    },
    include: requestInclude,
  });

  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'completed',
    subjectType: 'request',
    subjectId: request.id,
    message: approve ? `added ${describe(request)}` : `finished ${describe(request)}`,
  });
  pushRequestChange(householdId, modules, request);

  return request;
}

/**
 * Requests whose module allows it (Settings → Request types): a handler (media)
 * or the person asked (maintenance, before or after accepting) says no, with an
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
    message: `declined ${describe(request)}`,
  });
  pushRequestChange(householdId, modules, request);

  return request;
}

export async function deleteRequest(
  householdId: string,
  userId: string,
  id: string,
): Promise<void> {
  const existing = await getOwnRequest(householdId, id, userId);
  await prisma.request.delete({ where: { id } });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'deleted',
    subjectType: 'request',
    subjectId: id,
    message: `withdrew their request ${describe(existing)}`,
  });
  pushRequestChange(householdId, await getRequestModules(householdId), existing);
}
