// Groups the activity log's subject types into the filters on the Activity
// page (web /activity, app ⋮ → Activity). Pure so both the service and the
// page can use it; a subject type nobody listed falls under "household".

export const ACTIVITY_AREAS = [
  'tasks',
  'shopping',
  'inventory',
  'bills',
  'calendar',
  'requests',
  'household',
] as const;
export type ActivityArea = (typeof ACTIVITY_AREAS)[number];

export const ACTIVITY_AREA_LABELS: Record<ActivityArea, string> = {
  tasks: 'Tasks',
  shopping: 'Shopping',
  inventory: 'Stock',
  bills: 'Bills',
  calendar: 'Calendar',
  requests: 'Requests',
  household: 'Household',
};

const SUBJECTS: Record<Exclude<ActivityArea, 'household'>, string[]> = {
  tasks: ['task'],
  shopping: ['shopping_item', 'shopping_list'],
  inventory: ['inventory_item', 'nfc_tag'],
  bills: ['bill'],
  calendar: ['event'],
  requests: ['request'],
};

const KNOWN = new Set(Object.values(SUBJECTS).flat());

export function isActivityArea(value: string): value is ActivityArea {
  return (ACTIVITY_AREAS as readonly string[]).includes(value);
}

/** The filter an entry belongs to. */
export function areaOf(subjectType: string): ActivityArea {
  for (const [area, types] of Object.entries(SUBJECTS)) {
    if (types.includes(subjectType)) return area as ActivityArea;
  }
  return 'household';
}

/**
 * Subject types to match for an area: `in` for the feature areas, `notIn`
 * (everything else) for "household", so new admin subject types land there
 * without a code change.
 */
export function subjectFilter(area: ActivityArea): { in: string[] } | { notIn: string[] } {
  return area === 'household' ? { notIn: [...KNOWN] } : { in: SUBJECTS[area] };
}
