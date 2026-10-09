/**
 * Rotating assignees: a task holds an ordered list of member ids, and its
 * assignee moves along that list each time the task moves on — a recurring
 * task completed (no cycles), or a cycle ending, done or missed (one step
 * per cycle, so a missed turn still passes on). Pure helpers; the server
 * applies them in taskService. See docs/ARCHITECTURE.md "Rotating assignees".
 */

/** Max people in one rotation. */
export const MAX_ROTATION = 20;

export function parseRotation(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Stored form: distinct ids in order; fewer than two people = no rotation. */
export function formatRotation(ids: readonly string[] | null | undefined): string | null {
  const distinct = [...new Set((ids ?? []).map((s) => s.trim()).filter(Boolean))];
  return distinct.length >= 2 ? distinct.join(',') : null;
}

/**
 * Whose turn it is `steps` turns after `current`. Someone outside the list
 * (assigned by hand, or nobody) counts as standing just before its start, so
 * one step lands on the first person. Null when there is no rotation.
 */
export function nextInRotation(
  rotation: readonly string[],
  current: string | null | undefined,
  steps = 1,
): string | null {
  const n = rotation.length;
  if (n === 0) return null;
  const at = current ? rotation.indexOf(current) : -1;
  return rotation[(((at + steps) % n) + n) % n];
}

/**
 * The assignee a save should leave: the one asked for when they are in the
 * rotation, else the current one when they are, else the first person.
 */
export function assigneeForRotation(
  rotation: readonly string[],
  requested: string | null | undefined,
  current: string | null | undefined,
): string | null {
  if (rotation.length === 0) return requested === undefined ? (current ?? null) : requested;
  if (requested && rotation.includes(requested)) return requested;
  if (requested === undefined && current && rotation.includes(current)) return current;
  return rotation[0];
}
