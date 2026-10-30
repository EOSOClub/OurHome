// Task Photo Proof, the web UI's plain helpers: which server replies mean
// what, and the lines To check shows. No React here, so it can be tested.

import type { TaskSubmissionEntryDTO } from '@/lib/types';
import { ApiError } from '@/lib/api';
import { formatPoints, toCenti } from '@/lib/taskPoints';

/**
 * The machine codes the server puts on its check refusals (409,
 * error.details.code). The message is still what's shown; the code is what
 * the UI decides on.
 */
const CHECK_CODES = [
  'check_needed',
  'check_not_needed',
  'update_app',
  'check_waiting',
  'check_already_waiting',
  'check_decided',
  'check_cap',
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

/** The check refusal code of a failed call, if it has one. */
export function checkCode(err: unknown): CheckCode | null {
  if (!(err instanceof ApiError)) return null;
  const code = (err.details as { code?: unknown } | null | undefined)?.code;
  return (CHECK_CODES as readonly unknown[]).includes(code) ? (code as CheckCode) : null;
}

/** "+1 pt", "+5 pts", "+2.5 pts". */
export function plusPoints(points: number): string {
  const centi = toCenti(points);
  return `+${formatPoints(centi)} ${centi === 100 ? 'pt' : 'pts'}`;
}

/** "4:12 PM" today, else "Tue 4:12 PM", in the household's zone. */
export function checkTime(iso: string, timeZone?: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone });
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone });
  if (day(at) === day(now)) return time;
  return `${at.toLocaleDateString(undefined, { weekday: 'short', timeZone })} ${time}`;
}

/** "Decide by Tue 12:00 AM or it counts as done" (the cycle end). */
export function decideByLine(iso: string, timeZone?: string, now: Date = new Date()): string {
  return `Decide by ${checkTime(iso, timeZone, now)} or it counts as done`;
}

/**
 * The lines of a "steps" check, one per entry, except that the steps ticked
 * before one completion by someone else share a line:
 * "Ticked “Wipe the counter” again · Tue 4:12 PM (+1 pt)",
 * "Ticked 2 steps before Sam finished it · Wed 6:30 PM (+3 pts)".
 */
export function entryLines(
  entries: TaskSubmissionEntryDTO[],
  timeZone?: string,
  now: Date = new Date(),
): { key: string; text: string }[] {
  const lines: { key: string; text: string; at: string }[] = [];
  const groups = new Map<string, TaskSubmissionEntryDTO[]>();
  entries.forEach((e, i) => {
    if (e.awardKind === 'step' && e.completionId) {
      const list = groups.get(e.completionId);
      if (list) {
        list.push(e);
        return;
      }
      groups.set(e.completionId, [e]);
      lines.push({ key: `c:${e.completionId}`, text: '', at: e.checkedAt });
      return;
    }
    const what = e.awardKind === 'step_repeat' ? `Ticked “${e.title}” again` : `Ticked “${e.title}”`;
    lines.push({
      key: `e:${i}:${e.subtaskId}`,
      text: `${what} · ${checkTime(e.checkedAt, timeZone, now)} (${plusPoints(e.points)})`,
      at: e.checkedAt,
    });
  });
  return lines.map((line) => {
    if (!line.key.startsWith('c:')) return { key: line.key, text: line.text };
    const list = groups.get(line.key.slice(2))!;
    const latest = list.reduce((a, e) => (Date.parse(e.checkedAt) > Date.parse(a) ? e.checkedAt : a), list[0].checkedAt);
    const total = list.reduce((s, e) => s + toCenti(e.points), 0) / 100;
    const what = list.length === 1 ? `“${list[0].title}”` : `${list.length} steps`;
    const by = list[0].completedBy?.name;
    return {
      key: line.key,
      text: `Ticked ${what}${by ? ` before ${by} finished it` : ''} · ${checkTime(latest, timeZone, now)} (${plusPoints(total)})`,
    };
  });
}
