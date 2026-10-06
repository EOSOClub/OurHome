// Upper-bounded date filters that never match a missing date.
//
// Prisma's MongoDB connector compiles range filters to aggregation `$expr`
// comparisons, where a null or unset field sorts below every date. A bare
// `{ lt: now }` therefore matches rows with no date at all (e.g. undated tasks
// showed up as "overdue" on the dashboard). `not: null` doesn't cover fields
// that are unset rather than null, so a lower bound is used instead: it
// excludes both, and no real date in this app predates the epoch.
const EPOCH = new Date(0);

/** Matches dates strictly before `date`; excludes null/unset. */
export function dateBefore(date: Date) {
  return { gte: EPOCH, lt: date };
}

/** Matches dates at or before `date`; excludes null/unset. */
export function dateOnOrBefore(date: Date) {
  return { gte: EPOCH, lte: date };
}
