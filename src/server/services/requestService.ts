import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { pushSync } from '@/server/services/pushService';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@/server/services/errors';
import { MEDIA_TYPE_LABELS, type MediaType } from '@/lib/enums';
import { can } from '@/lib/permissions';
import type { RequestDTO } from '@/lib/types';
import type {
  AcceptRequestInput,
  CreateRequestInput,
  UpdateRequestInput,
} from '@/lib/validation/request';

// Household requests. Everyone in the household sees every request.
//   media:       only the requester may edit or delete it. Whoever holds
//                requests:manage_media (the head) accepts it and marks it
//                available. Rows from before statuses existed have no status;
//                treat that as pending.
//   maintenance: the requester asks another member (the assignee). The
//                assignee accepts with a done-by date (`dueAt`, the deadline),
//                may move that date, and marks it done. The requester may edit
//                or delete it; reassigning sends it back to "pending".

const requestInclude = {
  requester: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
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
 * the handler (assignee, or the head for media), and anyone in `also` (e.g. an
 * assignee it was just taken from). Each phone works out for itself whether to
 * alert, so waking an extra one costs nothing but a quiet re-check, and it
 * clears notifications that went stale on other devices.
 */
function pushRequestChange(
  householdId: string,
  r: { category: string; requesterId: string; assigneeId: string | null },
  also: (string | null)[] = [],
) {
  pushSync(
    householdId,
    {
      userIds: [r.requesterId, r.assigneeId, ...also],
      permission: r.category === 'media' ? 'requests:manage_media' : undefined,
    },
    'request',
  );
}

/** The household member a maintenance request is assigned to; never the requester. */
async function assertAssignable(householdId: string, assigneeId: string, requesterId: string) {
  if (assigneeId === requesterId) {
    throw new ConflictError('Choose someone else to do it.');
  }
  const member = await prisma.user.findFirst({
    where: { id: assigneeId, householdId },
    select: { id: true, name: true },
  });
  if (!member) throw new NotFoundError('That member is not in this household.');
  return member;
}

export async function listRequests(householdId: string): Promise<RequestWithPeople[]> {
  return prisma.request.findMany({
    where: { householdId },
    include: requestInclude,
    orderBy: { createdAt: 'desc' },
  });
}

export async function createRequest(
  householdId: string,
  userId: string,
  input: CreateRequestInput,
): Promise<RequestWithPeople> {
  let request: RequestWithPeople;
  let message: string;

  if (input.category === 'media') {
    request = await prisma.request.create({
      data: {
        householdId,
        requesterId: userId,
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
    const assignee = await assertAssignable(householdId, input.assigneeId, userId);
    request = await prisma.request.create({
      data: {
        householdId,
        requesterId: userId,
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
    actorId: userId,
    verb: 'created',
    subjectType: 'request',
    subjectId: request.id,
    message,
  });
  pushRequestChange(householdId, request);

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

export interface RequestActor {
  id: string;
  role: string;
}

/**
 * Loads a request the actor is the handler for: media → requests:manage_media
 * (the head); maintenance → the assignee.
 */
async function getHandledRequest(householdId: string, id: string, actor: RequestActor) {
  const existing = await getRequest(householdId, id);
  if (existing.category === 'media') {
    if (!can(actor.role, 'requests:manage_media')) {
      throw new ForbiddenError('Only the head of the household handles media requests.');
    }
  } else if (existing.assigneeId !== actor.id) {
    throw new ForbiddenError('Only the person this was assigned to can do that.');
  }
  return existing;
}

export async function updateRequest(
  householdId: string,
  userId: string,
  input: UpdateRequestInput,
): Promise<RequestWithPeople> {
  const existing = await getOwnRequest(householdId, input.id, userId);
  if (existing.category !== input.category) {
    throw new ConflictError("A request's category can't be changed.");
  }

  let data: Prisma.RequestUpdateInput;
  if (input.category === 'media') {
    data = {
      mediaType: input.mediaType,
      title: input.title,
      year: input.year,
      season: input.mediaType === 'tv' ? (input.season ?? null) : null,
    };
  } else {
    await assertAssignable(householdId, input.assigneeId, userId);
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
  pushRequestChange(householdId, request, [existing.assigneeId]);

  return request;
}

/**
 * Accepts a request. Maintenance: the assignee commits to (or moves) a done-by
 * date — the deadline. Media: the head accepts; no date.
 */
export async function acceptRequest(
  householdId: string,
  actor: RequestActor,
  input: AcceptRequestInput,
): Promise<RequestWithPeople> {
  const existing = await getHandledRequest(householdId, input.id, actor);
  if (existing.status === 'completed') {
    throw new ConflictError('This request is already done.');
  }
  const isMaintenance = existing.category === 'maintenance';
  if (isMaintenance && !input.dueAt) {
    throw new ConflictError("Pick the date you'll have it done by.");
  }
  const rescheduling = existing.status === 'accepted';

  const request = await prisma.request.update({
    where: { id: input.id },
    data: {
      status: 'accepted',
      ...(isMaintenance ? { dueAt: input.dueAt } : {}),
      acceptedAt: existing.acceptedAt ?? new Date(),
    },
    include: requestInclude,
  });

  let message = `accepted ${describe(request)}`;
  if (isMaintenance) {
    const when = input.dueAt!.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    message = rescheduling
      ? `moved ${describe(request)} to ${when}`
      : `accepted ${describe(request)}, done by ${when}`;
  }
  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'updated',
    subjectType: 'request',
    subjectId: request.id,
    message,
  });
  pushRequestChange(householdId, request);

  return request;
}

/** Maintenance: the assignee marks it done. Media: the head marks it available. */
export async function completeRequest(
  householdId: string,
  actor: RequestActor,
  id: string,
): Promise<RequestWithPeople> {
  const existing = await getHandledRequest(householdId, id, actor);
  if (existing.status === 'completed') {
    throw new ConflictError('This request is already done.');
  }

  const request = await prisma.request.update({
    where: { id },
    data: { status: 'completed', completedAt: new Date() },
    include: requestInclude,
  });

  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'completed',
    subjectType: 'request',
    subjectId: request.id,
    message:
      request.category === 'media'
        ? `made ${describe(request)} available`
        : `finished ${describe(request)}`,
  });
  pushRequestChange(householdId, request);

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
  pushRequestChange(householdId, existing);
}
