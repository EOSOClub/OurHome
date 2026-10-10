import { Prisma } from '@prisma/client';
import { getPointsSettings } from '@/server/services/pointsService';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { NotFoundError } from '@/server/services/errors';
import {
  computeNextRunAt,
  formatIntList,
  parseIntList,
  type NormalizedRule,
} from '@/server/services/recurrenceService';
import type { EventOccurrenceDTO } from '@/lib/types';
import type { RecurrenceInput } from '@/lib/validation/task';
import type {
  CreateEventInput,
  UpdateEventInput,
} from '@/lib/validation/calendar';

const eventInclude = {
  recurrence: true,
  attendees: { include: { user: { select: { id: true, name: true } } } },
} satisfies Prisma.EventInclude;

type EventWithRelations = Prisma.EventGetPayload<{ include: typeof eventInclude }>;

// Cap occurrence expansion so a malformed rule can never loop forever.
const MAX_OCCURRENCES = 500;

function buildRule(r: EventWithRelations['recurrence'], timeZone?: string): NormalizedRule | null {
  if (!r) return null;
  return {
    kind: r.kind as NormalizedRule['kind'],
    interval: r.interval,
    byWeekday: parseIntList(r.byWeekday),
    byMonthday: parseIntList(r.byMonthday),
    cron: r.cron,
    anchorDate: r.anchorDate,
    until: r.until,
    // The household's zone: events keep their local time across DST.
    timeZone,
  };
}

/** Persisted RecurrenceRule columns for an event; anchored to the start time. */
function recurrenceData(recurrence: RecurrenceInput, anchor: Date) {
  return {
    kind: recurrence.kind,
    interval: recurrence.interval,
    byWeekday: formatIntList(recurrence.byWeekday),
    byMonthday: formatIntList(recurrence.byMonthday),
    cron: recurrence.cron ?? null,
    timezone: recurrence.timezone,
    anchorDate: anchor,
    until: recurrence.until ?? null,
    nextRunAt: anchor,
  };
}

function occurrence(e: EventWithRelations, start: Date): EventOccurrenceDTO {
  const durationMs =
    e.endAt != null ? e.endAt.getTime() - e.startAt.getTime() : null;
  const end = durationMs != null ? new Date(start.getTime() + durationMs) : null;
  return {
    eventId: e.id,
    createdById: e.createdById,
    title: e.title,
    description: e.description,
    location: e.location,
    allDay: e.allDay,
    start: start.toISOString(),
    end: end?.toISOString() ?? null,
    baseStart: e.startAt.toISOString(),
    baseEnd: e.endAt?.toISOString() ?? null,
    recurring: !!e.recurrence,
    recurrence: e.recurrence
      ? {
          kind: e.recurrence.kind,
          interval: e.recurrence.interval,
          byWeekday: e.recurrence.byWeekday,
          byMonthday: e.recurrence.byMonthday,
          timezone: e.recurrence.timezone,
          until: e.recurrence.until?.toISOString() ?? null,
          nextRunAt: e.recurrence.nextRunAt?.toISOString() ?? null,
        }
      : null,
    attendees: e.attendees.map((a) => ({ id: a.user.id, name: a.user.name })),
  };
}

/** Expand all events into individual occurrences within [rangeStart, rangeEnd]. */
export async function listOccurrences(
  householdId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<EventOccurrenceDTO[]> {
  const [events, { timezone }] = await Promise.all([
    prisma.event.findMany({ where: { householdId }, include: eventInclude }),
    getPointsSettings(householdId),
  ]);

  const out: EventOccurrenceDTO[] = [];
  for (const e of events) {
    const rule = buildRule(e.recurrence, timezone);
    if (!rule) {
      const overlapEnd = e.endAt ?? e.startAt;
      if (e.startAt <= rangeEnd && overlapEnd >= rangeStart) {
        out.push(occurrence(e, e.startAt));
      }
      continue;
    }
    let from = new Date(rangeStart.getTime() - 1);
    let guard = 0;
    while (guard < MAX_OCCURRENCES) {
      const next = computeNextRunAt(rule, from);
      if (!next || next > rangeEnd) break;
      if (next >= rangeStart) out.push(occurrence(e, next));
      from = next;
      guard += 1;
    }
  }

  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

/** Limit attendee ids to actual members of this household. */
async function validAttendeeIds(
  householdId: string,
  ids: string[] | undefined,
): Promise<string[]> {
  if (!ids || ids.length === 0) return [];
  const members = await prisma.user.findMany({
    where: { householdId, id: { in: ids } },
    select: { id: true },
  });
  return members.map((m) => m.id);
}

export async function createEvent(
  householdId: string,
  userId: string,
  input: CreateEventInput,
): Promise<EventOccurrenceDTO> {
  const attendeeIds = await validAttendeeIds(householdId, input.attendeeIds);

  const event = await prisma.$transaction(async (tx) => {
    let recurrenceId: string | undefined;
    if (input.recurrence) {
      const rule = await tx.recurrenceRule.create({
        data: recurrenceData(input.recurrence, input.startAt),
      });
      recurrenceId = rule.id;
    }
    const created = await tx.event.create({
      data: {
        householdId,
        title: input.title.trim(),
        description: input.description ?? null,
        location: input.location ?? null,
        startAt: input.startAt,
        endAt: input.endAt ?? null,
        allDay: input.allDay,
        recurrenceId,
        createdById: userId,
        attendees: attendeeIds.length
          ? { create: attendeeIds.map((uid) => ({ userId: uid })) }
          : undefined,
      },
      include: eventInclude,
    });
    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'created',
        subjectType: 'event',
        subjectId: created.id,
        message: `added event “${created.title}”`,
      },
      tx,
    );
    return created;
  });

  return occurrence(event, event.startAt);
}

export async function updateEvent(
  householdId: string,
  userId: string,
  input: UpdateEventInput,
): Promise<EventOccurrenceDTO> {
  const { id, recurrence, attendeeIds, ...rest } = input;

  const event = await prisma.$transaction(async (tx) => {
    const existing = await tx.event.findFirst({
      where: { id, householdId },
      select: { id: true, recurrenceId: true, startAt: true },
    });
    if (!existing) throw new NotFoundError(`Event ${id} not found.`);

    let recurrenceId: string | null | undefined; // undefined = unchanged
    if (recurrence === null) {
      recurrenceId = null;
    } else if (recurrence) {
      const anchor = rest.startAt ?? existing.startAt;
      const data = recurrenceData(recurrence, anchor);
      if (existing.recurrenceId) {
        await tx.recurrenceRule.update({
          where: { id: existing.recurrenceId },
          data,
        });
      } else {
        const rule = await tx.recurrenceRule.create({ data });
        recurrenceId = rule.id;
      }
    }

    if (attendeeIds) {
      const valid = await prisma.user.findMany({
        where: { householdId, id: { in: attendeeIds } },
        select: { id: true },
      });
      await tx.eventAttendee.deleteMany({ where: { eventId: id } });
      if (valid.length) {
        await tx.eventAttendee.createMany({
          data: valid.map((m) => ({ eventId: id, userId: m.id })),
        });
      }
    }

    const updated = await tx.event.update({
      where: { id },
      data: {
        title: rest.title?.trim(),
        description: rest.description,
        location: rest.location,
        startAt: rest.startAt,
        endAt: rest.endAt,
        allDay: rest.allDay,
        recurrenceId,
      },
      include: eventInclude,
    });

    if (recurrence === null && existing.recurrenceId) {
      await tx.recurrenceRule.delete({ where: { id: existing.recurrenceId } });
    }

    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'updated',
        subjectType: 'event',
        subjectId: updated.id,
        message: `updated event “${updated.title}”`,
      },
      tx,
    );
    return updated;
  });

  return occurrence(event, event.startAt);
}

export async function deleteEvent(
  householdId: string,
  userId: string,
  id: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.event.findFirst({
      where: { id, householdId },
      select: { id: true, title: true, recurrenceId: true },
    });
    if (!existing) throw new NotFoundError(`Event ${id} not found.`);

    await tx.event.delete({ where: { id: existing.id } });
    if (existing.recurrenceId) {
      await tx.recurrenceRule.delete({ where: { id: existing.recurrenceId } });
    }
    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'deleted',
        subjectType: 'event',
        subjectId: existing.id,
        message: `deleted event “${existing.title}”`,
      },
      tx,
    );
  });
}
