// Formats generated reminder notifications as short plain-text emails. Kept as
// pure functions (base URL injectable) so reminderService.test.ts can cover the
// formatting without SMTP or env setup.

import { APP_NAME } from '@/server/config';

export interface ReminderEmailInput {
  type: string;
  title: string;
  body: string | null;
  subjectType: string;
}

export interface ReminderEmailContent {
  subject: string;
  text: string;
}

/** Human-readable subject prefix per generated notification type. */
const SUBJECT_PREFIX: Record<string, string> = {
  overdue: 'Overdue task',
  low_inventory: 'Low inventory',
  reminder: 'Reminder',
  bill_due: 'Bill due',
};

/** App section to deep-link per subject type; falls back to the inbox. */
const SUBJECT_PATH: Record<string, string> = {
  task: '/tasks',
  inventory_item: '/inventory',
  bill: '/bills',
};

/**
 * Build the subject/body for a reminder email. `baseUrl` defaults to the
 * site's public URL (BETTER_AUTH_URL, PUBLIC_URL on the server);
 * pass `null` — or leave the env unset — to omit the link.
 */
export function buildReminderEmail(
  candidate: ReminderEmailInput,
  baseUrl: string | null = process.env.BETTER_AUTH_URL ?? null,
): ReminderEmailContent {
  const prefix = SUBJECT_PREFIX[candidate.type] ?? 'Notification';
  const lines = [candidate.title];
  if (candidate.body) lines.push('', candidate.body);
  if (baseUrl) {
    const path = SUBJECT_PATH[candidate.subjectType] ?? '/notifications';
    lines.push('', `View in the app: ${baseUrl.replace(/\/$/, '')}${path}`);
  }
  lines.push('', `— ${APP_NAME}`);
  return {
    subject: `${prefix}: ${candidate.title}`,
    text: lines.join('\n'),
  };
}
