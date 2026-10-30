// "What's new": shown once per person after an update, on the website or the
// app, whichever they open first (User.changelogSeen). Written for the
// household, not for developers.
//
// Adding a release: put a new entry at the top. `id` is the release date,
// YYYY-MM-DD, with a letter after it for a second release that day
// ("2026-11-02b"); ids sort as text, so never reuse or change one.

export interface ChangelogEntry {
  /** Unique and fixed once released: the release date, plus a letter for a second one that day. */
  id: string;
  /** When it came out, YYYY-MM-DD. */
  date: string;
  title: string;
  /** What changed, one plain sentence each. */
  changes: string[];
}

/** Newest first. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-10-29',
    date: '2026-10-29',
    title: 'Calendar, notifications and requests',
    changes: [
      'New on the calendar asks what you are adding: an event, appointment, birthday, reminder, bill or subscription, each with its own form.',
      'Things can now repeat every year, and you can change just one date of something that repeats.',
      'Events can remind you before they start, in the bell, by email and on your phone.',
      'Chores show on the calendar too, with Everyone and Mine to choose whose.',
      'Tap the month name on the calendar to jump to any month or year.',
      'Reading a notification on one device marks it read on all of them.',
      'The Requests tab only shows a number when something new came in since you last looked.',
      'After each update, a list like this one shows what changed, once.',
    ],
  },
];

/** At most this many entries pop up at once; older ones are skipped. */
const MAX_SHOWN = 5;

/**
 * The entries `seen` (their newest closed entry id) hasn't seen, newest first.
 * Never seen any: the ones that came out after they joined, so a new member
 * isn't shown the whole history.
 */
export function unseenChangelog(
  seen: string | null,
  joinedAt: Date,
  entries: ChangelogEntry[] = CHANGELOG,
): ChangelogEntry[] {
  const joined = joinedAt.toISOString().slice(0, 10);
  return entries.filter((e) => (seen === null ? e.date > joined : e.id > seen)).slice(0, MAX_SHOWN);
}

/** The newest entry's id, or null with no entries. */
export function latestChangelogId(entries: ChangelogEntry[] = CHANGELOG): string | null {
  return entries[0]?.id ?? null;
}
