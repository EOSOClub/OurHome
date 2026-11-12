import { Prisma } from '@prisma/client';
import { getPointsSettings } from '@/server/services/pointsService';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { ConflictError, NotFoundError } from '@/server/services/errors';
import { addDays, localDateOf, startOfLocalDate } from '@/lib/taskCycles';
import {
  computeNextRunAt,
  formatIntList,
  fromWall,
  toWall,
  parseIntList,
  type NormalizedRule,
} from '@/server/services/recurrenceService';
import type { EventKind, RecurrenceKind } from '@/lib/enums';
import type { EventOccurrenceDTO } from '@/lib/types';
import type { RecurrenceInput } from '@/lib/validation/task';
import {
  kindProblem,
  type CreateEventInput,
  type DeleteEventInput,
  type UpdateEventInput,
} from '@/lib/validation/calendar';

const eventInclude = {
  recurrence: true,
  attendees: { include: { user: { select: { id: true, name: true } } } },
} satisfies Prisma.EventInclude;

type EventWithRelations = Prisma.EventGetPayload<{ include: typeof eventInclude }>;
type RuleRow = NonNullable<EventWithRelations['recurrence']>;
type Tx = Prisma.TransactionClient;

/** The fields an edit can change, without the id, scope, repeat and attendees. */
type EventChanges = Omit<
  UpdateEventInput,
  'id' | 'scope' | 'occurrenceStart' | 'recurrence' | 'attendeeIds'
>;

/** The rule columns recurrenceData reads (RecurrenceInput or a stored rule). */
type RuleFields = Pick<
  RecurrenceInput,
  'kind' | 'interval' | 'byWeekday' | 'byMonthday' | 'cron' | 'timezone' | 'until'
>;

// Cap occurrence expansion so a malformed rule can never loop forever.
const MAX_OCCURRENCES = 500;
// Longer than any local day (25 hours on a DST change), with room to spare:
// how far back an all-day date with no end can start and still be on.
const MAX_DAY_MS = 26 * 3_600_000;

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
function recurrenceData(recurrence: RuleFields, anchor: Date) {
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

/** A stored rule back in input form, to start a new series with the same repeat. */
function ruleFieldsOf(r: RuleRow): RuleFields {
  return {
    kind: r.kind as RecurrenceKind,
    interval: r.interval,
    byWeekday: parseIntList(r.byWeekday),
    byMonthday: parseIntList(r.byMonthday),
    cron: r.cron ?? undefined,
    timezone: r.timezone,
    until: r.until,
  };
}

/**
 * Whether `input` repeats differently from the stored rule. The end date
 * doesn't count: moving it leaves every remaining date where it was.
 */
export function repeatChanged(stored: RuleRow, input: RuleFields): boolean {
  return (
    stored.kind !== input.kind ||
    stored.interval !== input.interval ||
    (stored.byWeekday ?? null) !== formatIntList(input.byWeekday) ||
    (stored.byMonthday ?? null) !== formatIntList(input.byMonthday)
  );
}

/**
 * `occurrence` one listed date of an event. A date changed on its own (an
 * override row) carries its series' repeat, so the dialog offers the same
 * This / following / all choices for it.
 */
function occurrence(
  e: EventWithRelations,
  start: Date,
  repeat: EventWithRelations['recurrence'] = e.recurrence,
): EventOccurrenceDTO {
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
    recurring: !!repeat,
    recurrence: repeat
      ? {
          kind: repeat.kind,
          interval: repeat.interval,
          byWeekday: repeat.byWeekday,
          byMonthday: repeat.byMonthday,
          timezone: repeat.timezone,
          until: repeat.until?.toISOString() ?? null,
          nextRunAt: repeat.nextRunAt?.toISOString() ?? null,
        }
      : null,
    attendees: e.attendees.map((a) => ({ id: a.user.id, name: a.user.name })),
    seriesId: e.seriesId ?? null,
    originalStart: e.originalStart?.toISOString() ?? null,
    reminderMinutes: e.reminderMinutes ?? null,
    kind: e.kind as EventKind,
    billId: e.billId ?? null,
    billAssigneeId: null,
    sinceYear: e.sinceYear ?? null,
    provider: e.provider ?? null,
    phone: e.phone ?? null,
  };
}

const hasYear = (kind: string) => kind === 'birthday' || kind === 'anniversary';

/**
 * The kind's own fields from an input, the rest left out: a year only on a
 * birthday or anniversary, who and phone only on an appointment. `undefined`
 * = not given (an edit leaves the stored value).
 */
function kindFields(
  kind: string,
  input: { sinceYear?: number | null; provider?: string | null; phone?: string | null },
) {
  return {
    sinceYear: hasYear(kind) ? input.sinceYear : undefined,
    provider: kind === 'appointment' ? input.provider : undefined,
    phone: kind === 'appointment' ? input.phone : undefined,
  };
}

/**
 * The starts of one event within [rangeStart, rangeEnd]: its own start for a
 * one-off event, the rule's dates for a series (each when it overlaps the
 * range), less the dates left out of it (`excludedStarts`). Pure, for tests.
 */
export function expandEvent(
  e: { startAt: Date; endAt: Date | null; allDay?: boolean; excludedStarts?: Date[] | null },
  rule: NormalizedRule | null,
  rangeStart: Date,
  rangeEnd: Date,
  timeZone?: string,
): Date[] {
  // An all-day date saved with no end (every birthday and anniversary: the
  // dialog sends none for a yearly event) counts as on until the end of its
  // day in the household's zone, so it is still today's when asked from later
  // that day (the dashboard asks from now). Only the overlap test uses this;
  // the listed date keeps no end.
  const zone = rule?.timeZone ?? timeZone ?? 'UTC';
  const openAllDay = !!e.allDay && !e.endAt;
  const endOfDay = (start: Date) =>
    startOfLocalDate(addDays(localDateOf(start, zone), 1), zone).getTime() - 1;
  if (!rule) {
    const overlapEnd = e.endAt ?? (openAllDay ? new Date(endOfDay(e.startAt)) : e.startAt);
    return e.startAt <= rangeEnd && overlapEnd >= rangeStart ? [e.startAt] : [];
  }
  const skipped = new Set((e.excludedStarts ?? []).map((d) => d.getTime()));
  const out: Date[] = [];
  // Overlap, like a one-off: a date that began before the range but is still
  // on at its start (in progress, all day today, a trip from last month).
  const durationMs = e.endAt ? Math.max(0, e.endAt.getTime() - e.startAt.getTime()) : 0;
  const endOf = (start: Date) => (openAllDay ? endOfDay(start) : start.getTime() + durationMs);
  let from = new Date(rangeStart.getTime() - (openAllDay ? MAX_DAY_MS : durationMs) - 1);
  let guard = 0;
  while (guard < MAX_OCCURRENCES) {
    const next = computeNextRunAt(rule, from);
    if (!next || next > rangeEnd) break;
    if (endOf(next) >= rangeStart.getTime() && !skipped.has(next.getTime())) out.push(next);
    from = next;
    guard += 1;
  }
  return out;
}

/** Whether `start` is one of the series' dates (and not left out of it). */
export function isOccurrence(
  rule: NormalizedRule,
  excludedStarts: Date[] | null | undefined,
  start: Date,
): boolean {
  const at = computeNextRunAt(rule, new Date(start.getTime() - 1));
  return (
    !!at &&
    at.getTime() === start.getTime() &&
    !(excludedStarts ?? []).some((d) => d.getTime() === start.getTime())
  );
}

/**
 * The events that can have a date in [rangeStart, rangeEnd]: every repeating
 * one (its rule decides, in expandEvent), and the one-off ones that overlap
 * the range by expandEvent's own test (start on or before the range's end,
 * and end - or start, without an end, or the end of its day for an all-day
 * one - on or after its start). Loading every
 * event ever made, as this once did, grew with each past date on the
 * calendar, and the dashboard and the reminder sweep call this all the time.
 *
 * It may load a little more than it lists (expandEvent still decides), but
 * never less. A date changed on its own (seriesId) is a one-off row, so it is
 * found by its dates; its series repeats, so it is always loaded too, which
 * is what lends the changed date its series' repeat below.
 *
 * MongoDB (see db/dateFilters): a missing or null date sorts below every
 * date, so a lower bound (`gte`) never matches one, while an upper bound
 * (`lte`) does. Only `startAt` gets an upper bound here, and it is always
 * set; a missing `endAt` simply fails the second branch and is caught by the
 * third. `not: null` alone matches a missing field too, hence `isSet` next to it.
 */
function eventsInRange(householdId: string, rangeStart: Date, rangeEnd: Date): Prisma.EventWhereInput {
  return {
    householdId,
    OR: [
      { AND: [{ recurrenceId: { isSet: true } }, { recurrenceId: { not: null } }] },
      // One-off with an end: it overlaps when it starts by the range's end and ends after its start.
      { startAt: { lte: rangeEnd }, endAt: { gte: rangeStart } },
      // One-off without an end (or with one, a harmless extra): it starts inside the range.
      { startAt: { gte: rangeStart, lte: rangeEnd } },
      // All day with no end: on until the end of its day, so it may have
      // started up to a day before the range (expandEvent checks the day).
      { allDay: true, startAt: { gte: new Date(rangeStart.getTime() - MAX_DAY_MS), lte: rangeEnd } },
    ],
  };
}

/** Expand the events into individual occurrences within [rangeStart, rangeEnd]. */
export async function listOccurrences(
  householdId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<EventOccurrenceDTO[]> {
  const [events, { timezone }] = await Promise.all([
    prisma.event.findMany({ where: eventsInRange(householdId, rangeStart, rangeEnd), include: eventInclude }),
    getPointsSettings(householdId),
  ]);
  const byId = new Map(events.map((e) => [e.id, e]));
  // Who each bill on the calendar is for, so "Mine" can count it.
  const billIds = [...new Set(events.map((e) => e.billId).filter((id): id is string => !!id))];
  const billAssignee = new Map(
    billIds.length
      ? (
          await prisma.bill.findMany({
            where: { householdId, id: { in: billIds } },
            select: { id: true, assignedUserId: true },
          })
        ).map((b) => [b.id, b.assignedUserId])
      : [],
  );

  const out: EventOccurrenceDTO[] = [];
  for (const e of events) {
    const rule = buildRule(e.recurrence, timezone);
    const repeat = e.recurrence ?? (e.seriesId ? byId.get(e.seriesId)?.recurrence : null) ?? null;
    for (const start of expandEvent(e, rule, rangeStart, rangeEnd, timezone)) {
      const o = occurrence(e, start, repeat);
      if (e.billId) o.billAssigneeId = billAssignee.get(e.billId) ?? null;
      out.push(o);
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

  const own = kindFields(input.kind, input);
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
        kind: input.kind,
        sinceYear: own.sinceYear ?? null,
        provider: own.provider ?? null,
        phone: own.phone ?? null,
        title: input.title.trim(),
        description: input.description ?? null,
        location: input.location ?? null,
        startAt: input.startAt,
        endAt: input.endAt ?? null,
        allDay: input.allDay,
        reminderMinutes: input.reminderMinutes ?? null,
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

/** The series' first date, or null when its rule produces none. */
function firstOccurrence(series: EventWithRelations, rule: NormalizedRule): Date | null {
  return computeNextRunAt(rule, new Date(series.startAt.getTime() - 1));
}

/**
 * `own`: the original date of the changed date the dialog was opened from.
 * Its series leaves that date out on purpose (the row stands in for it), so
 * it still counts as one of the series' dates here.
 */
function assertOccurrence(series: EventWithRelations, rule: NormalizedRule, start: Date, own?: Date) {
  const excluded = own
    ? series.excludedStarts.filter((d) => d.getTime() !== own.getTime())
    : series.excludedStarts;
  if (!isOccurrence(rule, excluded, start)) {
    throw new ConflictError('That date isn’t part of this repeating event any more. Refresh and try again.');
  }
}

/**
 * Values for a new row cut from `source` at `start` (an override row or the
 * start of a new series): the source's fields with the dialog's changes on
 * top. Without a new start the row keeps the source's length.
 */
function cutFrom(source: EventWithRelations, start: Date, changes: EventChanges) {
  const durationMs =
    source.endAt != null ? source.endAt.getTime() - source.startAt.getTime() : null;
  const startAt = changes.startAt ?? start;
  const endAt =
    changes.endAt !== undefined
      ? changes.endAt
      : durationMs != null
        ? new Date(startAt.getTime() + durationMs)
        : null;
  const own = kindFields(source.kind, changes);
  return {
    kind: source.kind,
    sinceYear: own.sinceYear !== undefined ? own.sinceYear : source.sinceYear,
    provider: own.provider !== undefined ? own.provider : source.provider,
    phone: own.phone !== undefined ? own.phone : source.phone,
    title: (changes.title ?? source.title).trim(),
    description: changes.description !== undefined ? changes.description : source.description,
    location: changes.location !== undefined ? changes.location : source.location,
    startAt,
    endAt,
    allDay: changes.allDay ?? source.allDay,
    reminderMinutes:
      changes.reminderMinutes !== undefined ? changes.reminderMinutes : source.reminderMinutes,
    // The series' owner keeps owning its dates (own vs. others' access).
    createdById: source.createdById,
  };
}

/** The original whole-event edit: fields, attendees and repeat of one row. */
async function updateRow(
  tx: Tx,
  householdId: string,
  existing: EventWithRelations,
  changes: EventChanges,
  attendees: string[] | undefined,
  recurrence: UpdateEventInput['recurrence'],
  /** The household's zone, for a series edit: its removed dates move with it. */
  timeZone?: string,
): Promise<EventWithRelations> {
  const id = existing.id;
  let recurrenceId: string | null | undefined; // undefined = unchanged
  if (recurrence === null) {
    recurrenceId = null;
  } else if (recurrence) {
    const anchor = changes.startAt ?? existing.startAt;
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

  if (attendees) {
    await tx.eventAttendee.deleteMany({ where: { eventId: id } });
    if (attendees.length) {
      await tx.eventAttendee.createMany({
        data: attendees.map((userId) => ({ eventId: id, userId })),
      });
    }
  }

  // A moved series, a new repeat or no repeat at all: the dates changed on
  // their own no longer line up, so they go (the dialog warns first).
  const startMoved =
    changes.startAt !== undefined && changes.startAt.getTime() !== existing.startAt.getTime();
  const dropExceptions =
    !!existing.recurrence &&
    (startMoved ||
      recurrence === null ||
      (!!recurrence && repeatChanged(existing.recurrence, recurrence)));
  // Dates removed one at a time ("This event", delete) have no row, only an
  // entry in excludedStarts. When only the time moved they are still removed:
  // they move with the series. Clearing them brought every one of them back.
  let movedExcluded: Date[] = [];
  const repeatKept = recurrence === undefined || (!!recurrence && !repeatChanged(existing.recurrence!, recurrence));
  if (dropExceptions && startMoved && repeatKept && timeZone) {
    const rows = await tx.event.findMany({
      where: { householdId, seriesId: id },
      select: { originalStart: true },
    });
    const changed = new Set(rows.map((r) => r.originalStart?.getTime()));
    movedExcluded = existing.excludedStarts
      .filter((d) => !changed.has(d.getTime()))
      .map((d) => shiftedLike(d, existing.startAt, changes.startAt!, timeZone));
  }
  if (dropExceptions) {
    await tx.event.deleteMany({ where: { householdId, seriesId: id } });
  }

  let updated = await tx.event.update({
    where: { id },
    data: {
      title: changes.title?.trim(),
      description: changes.description,
      location: changes.location,
      startAt: changes.startAt,
      endAt: changes.endAt,
      allDay: changes.allDay,
      reminderMinutes: changes.reminderMinutes,
      ...kindFields(existing.kind, changes),
      recurrenceId,
      ...(dropExceptions ? { excludedStarts: { set: [] } } : {}),
    },
    include: eventInclude,
  });

  if (movedExcluded.length) {
    const rule = buildRule(updated.recurrence, timeZone);
    const still = rule ? movedExcluded.filter((d) => isOccurrence(rule, [], d)) : [];
    if (still.length) {
      updated = await tx.event.update({
        where: { id },
        data: { excludedStarts: { set: still } },
        include: eventInclude,
      });
    }
  }

  if (recurrence === null && existing.recurrenceId) {
    await tx.recurrenceRule.delete({ where: { id: existing.recurrenceId } });
  }
  return updated;
}

/**
 * Where a series split at `from` ("This and following") ends: the last moment
 * of the day before, in the household's zone. A repeat has one date a day at
 * most, so nothing before `from` is cut. It used to be `from` less a
 * millisecond, which the dialog read back as ending ON the split day; saving
 * that as a date brought the split day's date back into the earlier part.
 */
function endOfDayBefore(from: Date, timeZone: string): Date {
  return new Date(startOfLocalDate(localDateOf(from, timeZone), timeZone).getTime() - 1);
}

/** `d` moved by as much clock time, in the household's zone, as `from` moved to `to`. */
function shiftedLike(d: Date, from: Date, to: Date, timeZone: string): Date {
  const delta = toWall(to, timeZone).getTime() - toWall(from, timeZone).getTime();
  return fromWall(new Date(toWall(d, timeZone).getTime() + delta), timeZone);
}

/**
 * A date moved to another day must still be one of the repeat's days. A
 * "weekly on Tuesdays" date moved to a Wednesday with Tuesday still picked
 * was not: "This and following" lost that week's date, and "All events" saved
 * without moving anything. Refused, so the day can be picked under Repeat.
 */
function assertMovedDayRepeats(rule: NormalizedRule | null, movedTo: Date, timeZone: string) {
  if (!rule) return;
  const day = localDateOf(movedTo, timeZone);
  const next = computeNextRunAt(rule, new Date(startOfLocalDate(day, timeZone).getTime() - 1));
  if (!next || next >= startOfLocalDate(addDays(day, 1), timeZone)) {
    throw new ConflictError(
      'This event repeats on set days. Pick the new day under Repeat as well, so the moved date stays on the calendar.',
      'recurrence',
    );
  }
}

/**
 * Edit "all" from one opened date: the series moves by as much as the dialog
 * moved that date (`opened` is where the dialog started), so changing a
 * Tuesday's time changes every Tuesday's, not the first one's date.
 */
function shiftSeries(series: EventWithRelations, opened: Date, changes: EventChanges): EventChanges {
  if (!changes.startAt) return changes;
  const delta = changes.startAt.getTime() - opened.getTime();
  const startAt = new Date(series.startAt.getTime() + delta);
  const endAt =
    changes.endAt != null
      ? new Date(startAt.getTime() + (changes.endAt.getTime() - changes.startAt.getTime()))
      : changes.endAt;
  return { ...changes, startAt, endAt };
}

export async function updateEvent(
  householdId: string,
  userId: string,
  input: UpdateEventInput,
): Promise<EventOccurrenceDTO> {
  const { id, scope, occurrenceStart, recurrence, attendeeIds, ...changes } = input;
  const [{ timezone }, attendees] = await Promise.all([
    getPointsSettings(householdId),
    attendeeIds ? validAttendeeIds(householdId, attendeeIds) : Promise.resolve(undefined),
  ]);

  const event = await prisma.$transaction(async (tx) => {
    const { event: updated, message } = await applyUpdate(tx);
    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'updated',
        subjectType: 'event',
        subjectId: updated.id,
        message,
      },
      tx,
    );
    return updated;
  });

  return occurrence(event, event.startAt);

  /** The edit itself, by scope; returns the row it left and the activity line. */
  async function applyUpdate(tx: Tx): Promise<{ event: EventWithRelations; message: string }> {
    const existing = await tx.event.findFirst({
      where: { id, householdId },
      include: eventInclude,
    });
    if (!existing) throw new NotFoundError(`Event ${id} not found.`);
    // A bill's entry follows the bill (billCalendarService).
    if (existing.billId) {
      throw new ConflictError('This is a bill’s due date. Change it on the bill.', 'startAt');
    }

    // A birthday stays all-day and yearly, a reminder stays a moment.
    const problem = kindProblem(existing.kind, {
      allDay: changes.allDay ?? existing.allDay,
      repeat: recurrence === undefined ? undefined : (recurrence?.kind ?? null),
      hasEnd: changes.endAt !== undefined ? !!changes.endAt : !!existing.endAt,
    });
    if (problem) throw new ConflictError(problem.message, problem.field);

    // A date changed on its own: "This event" edits that row (it doesn't
    // repeat); the wider choices act on its series from its original date.
    let series = existing;
    let date = occurrenceStart;
    let opened = occurrenceStart;
    // The changed date the dialog was opened from, when it acts on its series.
    let ownDate: Date | undefined;
    // A series edit ("all" or "following") opened from a changed date: that
    // date takes the edit too (it is the one the user edited), unless the
    // series edit already dropped it. Other changed dates keep their own values on a
    // text-only edit, as before.
    const editOpenedDate = async (t: Tx) => {
      if (ownDate && (await t.event.findFirst({ where: { id: existing.id, householdId } }))) {
        await updateRow(t, householdId, existing, changes, attendees, undefined);
      }
    };
    if (existing.seriesId && existing.originalStart) {
      if (scope === 'this') {
        const row = await updateRow(tx, householdId, existing, changes, attendees, undefined);
        return { event: row, message: `changed one date of event “${row.title}”` };
      }
      const parent = await tx.event.findFirst({
        where: { id: existing.seriesId, householdId },
        include: eventInclude,
      });
      if (parent?.recurrence) {
        series = parent;
        date = existing.originalStart;
        opened = existing.startAt;
        ownDate = existing.originalStart;
      }
    }

    const rule = buildRule(series.recurrence, timezone);
    // Where the opened date lands once the whole series has moved with it.
    const assertOpenedDateRepeats = (row: EventWithRelations) => {
      if (!date || !opened || !changes.startAt || changes.startAt.getTime() === opened.getTime()) return;
      assertMovedDayRepeats(
        buildRule(row.recurrence, timezone),
        shiftedLike(date, opened, changes.startAt, timezone),
        timezone,
      );
    };
    if (!rule || scope === 'all' || !date) {
      const effective = rule && opened ? shiftSeries(series, opened, changes) : changes;
      const row = await updateRow(tx, householdId, series, effective, attendees, recurrence, timezone);
      if (rule) assertOpenedDateRepeats(row);
      await editOpenedDate(tx);
      return { event: row, message: `updated event “${row.title}”` };
    }

    const first = firstOccurrence(series, rule);
    if (scope === 'following' && first && date <= first) {
      // From the first date on is the whole series.
      const row = await updateRow(tx, householdId, series, shiftSeries(series, opened!, changes), attendees, recurrence, timezone);
      assertOpenedDateRepeats(row);
      await editOpenedDate(tx);
      return { event: row, message: `updated event “${row.title}”` };
    }
    assertOccurrence(series, rule, date, ownDate);
    const attendeesFor = attendees ?? series.attendees.map((a) => a.userId);

    if (scope === 'this') {
      // Leave the date out of the series and give it a row of its own.
      const override = await tx.event.create({
        data: {
          householdId,
          ...cutFrom(series, date, changes),
          seriesId: series.id,
          originalStart: date,
          attendees: attendeesFor.length
            ? { create: attendeesFor.map((uid) => ({ userId: uid })) }
            : undefined,
        },
        include: eventInclude,
      });
      await tx.event.update({
        where: { id: series.id },
        data: { excludedStarts: { push: date } },
      });
      return { event: override, message: `changed one date of event “${override.title}”` };
    }

    // "This and following": the series ends just before the date, and a new
    // one starts there with the changes (and the same repeat unless changed).
    const from = date;
    const nextChanges = shiftSeries({ ...series, startAt: from }, opened!, changes);
    const shiftedStart = nextChanges.startAt ?? from;
    const repeat: RuleFields | null =
      recurrence === undefined ? ruleFieldsOf(series.recurrence!) : recurrence;
    await tx.recurrenceRule.update({
      where: { id: series.recurrenceId! },
      data: { until: endOfDayBefore(from, timezone) },
    });
    const newRule = repeat
      ? await tx.recurrenceRule.create({ data: recurrenceData(repeat, shiftedStart) })
      : null;
    const later = series.excludedStarts.filter((d) => d >= from);
    const created = await tx.event.create({
      data: {
        householdId,
        ...cutFrom(series, from, nextChanges),
        recurrenceId: newRule?.id,
        attendees: attendeesFor.length
          ? { create: attendeesFor.map((uid) => ({ userId: uid })) }
          : undefined,
      },
      include: eventInclude,
    });

    // The dates changed on their own from here on follow the new series while
    // they still line up with it; a moved time or a new repeat drops them.
    const laterOverrides = await tx.event.findMany({
      where: { householdId, seriesId: series.id, originalStart: { gte: from } },
      select: { id: true, originalStart: true },
    });
    const newNormalized = buildRule(newRule, timezone);
    if (shiftedStart.getTime() !== from.getTime()) assertMovedDayRepeats(newNormalized, shiftedStart, timezone);
    const keep =
      !!newNormalized &&
      shiftedStart.getTime() === from.getTime() &&
      !repeatChanged(series.recurrence!, repeat!);
    // The changed date the dialog was opened from is kept like the others, as
    // "All events" keeps it: the dialog opened on its own (moved) time, so an
    // edit that leaves the time alone must not put it back on the series'
    // time. It takes the edit below. A changed time or repeat drops it.
    const fits = (d: Date) => keep && isOccurrence(newNormalized!, [], d);
    const keptOverrides = laterOverrides.filter((o) => fits(o.originalStart!));
    const droppedOverrides = laterOverrides.filter((o) => !fits(o.originalStart!));
    if (keptOverrides.length) {
      await tx.event.updateMany({
        where: { id: { in: keptOverrides.map((o) => o.id) } },
        data: { seriesId: created.id },
      });
    }
    if (droppedOverrides.length) {
      await tx.event.deleteMany({ where: { id: { in: droppedOverrides.map((o) => o.id) } } });
    }
    await tx.event.update({
      where: { id: series.id },
      data: { excludedStarts: { set: series.excludedStarts.filter((d) => d < from) } },
    });
    // Dates removed one at a time have no row. Kept as they are when the
    // later part keeps its time; when only the time moved (same repeat) they
    // move with it, so a removed date doesn't come back.
    const repeatSame = !!newNormalized && !repeatChanged(series.recurrence!, repeat!);
    const rowless = later.filter((d) => !laterOverrides.some((o) => o.originalStart!.getTime() === d.getTime()));
    const keptExcluded = keep
      ? later.filter(fits)
      : repeatSame
        ? rowless
            .map((d) => shiftedLike(d, from, shiftedStart, timezone))
            .filter((d) => isOccurrence(newNormalized!, [], d))
        : [];
    // The opened date, if kept, gets the dialog's changes (its own time stays).
    await editOpenedDate(tx);
    const result = keptExcluded.length
      ? await tx.event.update({
          where: { id: created.id },
          data: { excludedStarts: { set: keptExcluded } },
          include: eventInclude,
        })
      : created;
    return { event: result, message: `changed later dates of event “${result.title}”` };
  }
}

export async function deleteEvent(
  householdId: string,
  userId: string,
  input: DeleteEventInput,
): Promise<void> {
  const { id, scope, occurrenceStart } = input;
  const { timezone } = await getPointsSettings(householdId);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.event.findFirst({
      where: { id, householdId },
      include: eventInclude,
    });
    if (!existing) throw new NotFoundError(`Event ${id} not found.`);

    const log = (verb: 'deleted' | 'updated', subjectId: string, message: string) =>
      logActivity({ householdId, actorId: userId, verb, subjectType: 'event', subjectId, message }, tx);

    // A date changed on its own: "This event" removes that row (its date
    // stays left out of the series); the wider choices act on the series.
    let series = existing;
    let date = occurrenceStart;
    if (existing.seriesId && existing.originalStart) {
      const parent =
        scope === 'this'
          ? null
          : await tx.event.findFirst({ where: { id: existing.seriesId, householdId }, include: eventInclude });
      if (!parent?.recurrence) {
        await tx.event.delete({ where: { id: existing.id } });
        await log('updated', existing.seriesId, `removed one date of event “${existing.title}”`);
        return;
      }
      series = parent;
      date = existing.originalStart;
    }
    // The changed date opened, which its series leaves out on purpose.
    const ownDate = series === existing ? undefined : existing.originalStart ?? undefined;

    const rule = buildRule(series.recurrence, timezone);
    const first = rule ? firstOccurrence(series, rule) : null;
    const whole =
      !rule || scope === 'all' || !date || (scope === 'following' && (!first || date <= first));

    if (whole) {
      // Its dates changed on their own go with it.
      await tx.event.deleteMany({ where: { householdId, seriesId: series.id } });
      await tx.event.delete({ where: { id: series.id } });
      if (series.recurrenceId) {
        await tx.recurrenceRule.delete({ where: { id: series.recurrenceId } });
      }
      await log('deleted', series.id, `deleted event “${series.title}”`);
      return;
    }

    assertOccurrence(series, rule, date!, ownDate);
    if (scope === 'this') {
      await tx.event.update({
        where: { id: series.id },
        data: { excludedStarts: { push: date! } },
      });
      await log('updated', series.id, `removed one date of event “${series.title}”`);
      return;
    }

    // "This and following": the series ends just before the date.
    await tx.recurrenceRule.update({
      where: { id: series.recurrenceId! },
      data: { until: endOfDayBefore(date!, timezone) },
    });
    await tx.event.deleteMany({
      where: { householdId, seriesId: series.id, originalStart: { gte: date } },
    });
    await tx.event.update({
      where: { id: series.id },
      data: { excludedStarts: { set: series.excludedStarts.filter((d) => d < date!) } },
    });
    await log('updated', series.id, `removed later dates of event “${series.title}”`);
  });
}
