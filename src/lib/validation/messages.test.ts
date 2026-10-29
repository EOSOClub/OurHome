import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldErrors, fieldLabel, fieldProblem, validationMessage } from '@/lib/validation/messages';
import { createMemberSchema, usernameSchema } from '@/lib/validation/user';
import { passwordChangeError } from '@/lib/auth-errors';
import { fieldErrors as apiFieldErrors } from '@/lib/api';

const issues = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('expected a failure');
  return result.error.issues;
};

describe('validation messages', () => {
  it('says why a username with a space fails, naming the field', () => {
    const got = issues(createMemberSchema, { name: 'Mia', username: 'mia m', password: 'password1' });
    expect(fieldErrors(got)).toEqual({ username: 'Use only letters, numbers and . _ - (no spaces).' });
    expect(validationMessage(got)).toBe('Username: Use only letters, numbers and . _ - (no spaces).');
  });

  it('lists every field that failed, once each', () => {
    const got = issues(createMemberSchema, { name: '', username: 'a b', password: 'short', email: 'nope' });
    expect(Object.keys(fieldErrors(got)).sort()).toEqual(['email', 'name', 'password', 'username']);
    expect(validationMessage(got)).toBe(
      [
        'Name: Enter a name.',
        'Username: Use only letters, numbers and . _ - (no spaces).',
        'Email: Enter a valid email address, like name@example.com.',
        'Password: At least 8 characters.',
      ].join(' '),
    );
  });

  it('puts the built-in zod checks in plain words', () => {
    const schema = z.object({
      title: z.string().min(1),
      notes: z.string().max(5),
      count: z.number().int().min(0),
      kind: z.enum(['a', 'b']),
      due: z.string(),
      site: z.url(),
    });
    const got = fieldErrors(
      issues(schema, { title: '', notes: 'too long', count: -1, kind: 'c', site: 'not a url' }),
    );
    expect(got).toEqual({
      title: 'Can’t be empty.',
      notes: 'At most 5 characters.',
      count: 'Must be at least 0.',
      kind: 'Pick one of the choices.',
      due: 'Required.',
      site: 'Enter a full web address, starting with https://.',
    });
  });

  it('a message that isn’t about one field stands alone', () => {
    const schema = z.object({ a: z.string().optional() }).refine((v) => v.a, { message: 'Nothing to update.' });
    expect(validationMessage(issues(schema, {}))).toBe('Nothing to update.');
  });

  it('names a nested problem by its full place, and marks its top-level field', () => {
    const schema = z.object({
      recurrence: z.object({ interval: z.number().min(1) }),
      subtasks: z.array(z.object({ title: z.string().min(1) })),
    });
    const got = issues(schema, { recurrence: { interval: 0 }, subtasks: [{ title: 'ok' }, { title: '' }] });
    expect(validationMessage(got)).toBe('Recurrence interval: Must be at least 1. Subtasks 2 title: Can’t be empty.');
    expect(fieldErrors(got)).toEqual({
      recurrence: 'Recurrence interval: Must be at least 1.',
      subtasks: 'Subtasks 2 title: Can’t be empty.',
    });
  });

  it('checks a typed value by the server’s rule, leaving a blank field alone', () => {
    expect(fieldProblem(usernameSchema, 'mia m')).toBe('Use only letters, numbers and . _ - (no spaces).');
    expect(fieldProblem(usernameSchema, 'mia')).toBeNull();
    expect(fieldProblem(usernameSchema, '')).toBeNull();
  });

  it('turns a Better Auth password refusal into words and the field it’s about', () => {
    const wrong = passwordChangeError({ code: 'INVALID_PASSWORD', status: 400 }, 'fallback');
    expect(wrong.message).toBe('Your current password is incorrect.');
    expect(apiFieldErrors(wrong)).toEqual({ currentPassword: 'Your current password is incorrect.' });
    const short = passwordChangeError({ code: 'PASSWORD_TOO_SHORT' }, 'fallback');
    expect(apiFieldErrors(short)).toEqual({ newPassword: 'Your new password is too short: use at least 8 characters.' });
    const other = passwordChangeError({ message: 'Session expired' }, 'fallback');
    expect(other.message).toBe('Session expired');
    expect(apiFieldErrors(other)).toEqual({});
    expect(passwordChangeError({}, 'Could not change it.').message).toBe('Could not change it.');
  });

  it('labels fields in plain words', () => {
    expect(fieldLabel('username')).toBe('Username');
    expect(fieldLabel('dueAt')).toBe('Due at');
    expect(fieldLabel('supervisorIds')).toBe('Supervisor ids');
    expect(fieldLabel('room_id')).toBe('Room id');
  });
});
