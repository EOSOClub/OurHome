import { describe, expect, it } from 'vitest';
import { initials, isBirthday, publicProfile } from '@/lib/profile';
import { updateProfileSchema } from '@/lib/validation/user';

describe('isBirthday', () => {
  it('accepts real month-days, including Feb 29', () => {
    expect(isBirthday('01-01')).toBe(true);
    expect(isBirthday('02-29')).toBe(true);
    expect(isBirthday('12-31')).toBe(true);
  });
  it('rejects impossible or malformed days', () => {
    expect(isBirthday('02-30')).toBe(false);
    expect(isBirthday('04-31')).toBe(false);
    expect(isBirthday('13-01')).toBe(false);
    expect(isBirthday('00-10')).toBe(false);
    expect(isBirthday('1-1')).toBe(false);
  });
});

describe('initials', () => {
  it('uses first and last words', () => {
    expect(initials('jane van doe')).toBe('JD');
    expect(initials('Sam')).toBe('S');
    expect(initials('  ')).toBe('?');
  });
});

describe('publicProfile', () => {
  it('drops stored values that are no longer valid', () => {
    expect(
      publicProfile({ bio: 'hi', pronouns: null, avatarEmoji: '🦊', profileColor: 'mauve', birthday: '02-30' }),
    ).toEqual({ bio: 'hi', pronouns: null, avatarEmoji: '🦊', profileColor: null, birthday: null });
  });
});

describe('updateProfileSchema about-me fields', () => {
  it('turns blanks into null (cleared)', () => {
    expect(updateProfileSchema.parse({ bio: '  ', pronouns: '' })).toMatchObject({ bio: null, pronouns: null });
  });
  it('accepts one emoji, including joined and flag emoji', () => {
    for (const e of ['🦊', '👩‍👧', '🇺🇸', '❤️']) {
      expect(updateProfileSchema.safeParse({ avatarEmoji: e }).success).toBe(true);
    }
  });
  it('rejects text or several emoji', () => {
    for (const e of ['ab', '🦊🐱', 'x']) {
      expect(updateProfileSchema.safeParse({ avatarEmoji: e }).success).toBe(false);
    }
  });
  it('checks colour keys and birthdays', () => {
    expect(updateProfileSchema.safeParse({ profileColor: 'teal' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ profileColor: 'mauve' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ birthday: '02-30' }).success).toBe(false);
  });
  it('still refuses an empty update', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });
  it('allows clearing a field on its own', () => {
    expect(updateProfileSchema.safeParse({ profileColor: null }).success).toBe(true);
  });
});
