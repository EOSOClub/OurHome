// The days a month view shows, shared by the calendar page's first render (on
// the server) and the calendar's own fetches (in the browser), so both load
// the same range. Plain dates with no zone: each side turns them into
// instants in the household's zone.

export type GridMonth = { year: number; month: number };

/**
 * The month grid's whole weeks, Sunday first: `first` is the first cell (the
 * Sunday on or before the 1st) and `afterLast` the day after the last cell.
 * Both are wall dates at UTC midnight, so the result is the same in any zone.
 */
export function monthGridBounds({ year, month }: GridMonth): { first: Date; afterLast: Date } {
  const lead = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const weeks = Math.ceil((lead + daysInMonth) / 7);
  return {
    first: new Date(Date.UTC(year, month, 1 - lead)),
    afterLast: new Date(Date.UTC(year, month, 1 - lead + weeks * 7)),
  };
}

/** "YYYY-MM-DD" of a wall date from `monthGridBounds`. */
export function gridDayKey(wall: Date): string {
  return wall.toISOString().slice(0, 10);
}
