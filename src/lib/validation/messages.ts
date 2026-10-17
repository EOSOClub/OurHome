import { z } from 'zod';

// Plain-language validation messages. Zod's own wording ("Too small: expected
// string to have >=3 characters") isn't for the household, so its built-in
// checks get these instead; a message a schema gives itself still wins. Any
// module that validates input imports this (the API layer does), so every
// form's failure says what's wrong.

type Issue = z.core.$ZodRawIssue;

function plainMessage(issue: Issue): string | undefined {
  switch (issue.code) {
    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.origin === 'string') return min <= 1 ? 'Can’t be empty.' : `At least ${min} characters.`;
      if (issue.origin === 'array' || issue.origin === 'set') return min <= 1 ? 'Pick at least one.' : `Pick at least ${min}.`;
      if (issue.origin === 'date') return 'That date is too early.';
      return issue.inclusive === false ? `Must be more than ${min}.` : `Must be at least ${min}.`;
    }
    case 'too_big': {
      const max = Number(issue.maximum);
      if (issue.origin === 'string') return `At most ${max} characters.`;
      if (issue.origin === 'array' || issue.origin === 'set') return `At most ${max}.`;
      if (issue.origin === 'date') return 'That date is too late.';
      return issue.inclusive === false ? `Must be less than ${max}.` : `Must be at most ${max}.`;
    }
    case 'invalid_type':
      return issue.input === undefined || issue.input === null ? 'Required.' : 'That isn’t a valid value.';
    case 'invalid_format':
      if (issue.format === 'email') return 'Enter a valid email address, like name@example.com.';
      if (issue.format === 'url') return 'Enter a full web address, starting with https://.';
      return 'That isn’t in the right format.';
    case 'invalid_value':
      return 'Pick one of the choices.';
    default:
      return undefined;
  }
}

z.config({ customError: plainMessage });

/**
 * What's wrong with what was typed in a field, by the same rule the server
 * uses; null while it's empty (a blank field isn't marked until it's needed).
 */
export function fieldProblem(schema: z.ZodType, value: string): string | null {
  if (!value) return null;
  const result = schema.safeParse(value);
  return result.success ? null : (result.error.issues[0]?.message ?? 'That isn’t valid.');
}

/** "username" → "Username", "dueAt" → "Due at", for a message naming the field. */
export function fieldLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'This';
}

/**
 * The first message for each top-level field that failed (the field a person
 * typed in). A problem deeper inside one (a step of a checklist, the repeat
 * interval) says where, since the form marks the whole field.
 */
export function fieldErrors(issues: readonly z.core.$ZodIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (typeof key !== 'string' || key in out) continue;
    out[key] = issue.path.length > 1 ? `${pathLabel(issue.path)}: ${issue.message}` : issue.message;
  }
  return out;
}

/**
 * Where a problem is, in words: "Username", "Recurrence interval", "Subtasks
 * 3 title" (a list's items counted from 1). Null for the form as a whole.
 */
export function pathLabel(path: readonly PropertyKey[]): string | null {
  const words = path
    .map((p) => (typeof p === 'number' ? String(p + 1) : typeof p === 'string' ? fieldLabel(p).toLowerCase() : ''))
    .filter(Boolean)
    .join(' ');
  return words ? words[0].toUpperCase() + words.slice(1) : null;
}

/** One readable sentence for a failed form: "Username: Use letters, numbers… Password: At least 8 characters." */
export function validationMessage(issues: readonly z.core.$ZodIssue[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of issues) {
    const where = pathLabel(issue.path);
    const part = where ? `${where}: ${issue.message}` : issue.message;
    const dedupe = where ?? part;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    parts.push(/[.!?]$/.test(part) ? part : `${part}.`);
  }
  return parts.join(' ') || 'Something in the form isn’t right.';
}
