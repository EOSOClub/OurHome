/**
 * Self-chosen profile fields (User.bio/avatarEmoji/profileColor/
 * birthday). Every household member can see them; only the owner edits.
 * The Android app mirrors PROFILE_COLORS in data/ProfileStyle.kt.
 */

/** Accent colours a member can pick for their avatar (key → hex). */
export const PROFILE_COLORS = {
  slate: '#64748b',
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  green: '#22c55e',
  teal: '#14b8a6',
  blue: '#3b82f6',
  violet: '#8b5cf6',
  pink: '#ec4899',
} as const;

export type ProfileColor = keyof typeof PROFILE_COLORS;
export const PROFILE_COLOR_KEYS = Object.keys(PROFILE_COLORS) as ProfileColor[];

export function isProfileColor(v: unknown): v is ProfileColor {
  return typeof v === 'string' && v in PROFILE_COLORS;
}

export const BIO_MAX = 500;

/** "MM-DD" → true when it names a real day of some year (02-29 allowed). */
export function isBirthday(v: string): boolean {
  const m = /^(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1) return false;
  // 2000 is a leap year, so Feb 29 counts.
  return day <= new Date(Date.UTC(2000, month, 0)).getUTCDate();
}

/** "03-14" → "March 14" (locale month name). */
export function formatBirthday(v: string | null | undefined): string | null {
  if (!v || !isBirthday(v)) return null;
  const [month, day] = v.split('-').map(Number);
  const d = new Date(Date.UTC(2000, month - 1, day));
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** Initials fallback when there's no emoji: "Jane Doe" → "JD". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters.map((p) => [...p][0]?.toUpperCase() ?? '').join('') || '?';
}

/** What every member sees about someone (household members list, profile). */
export interface PublicProfile {
  bio: string | null;
  avatarEmoji: string | null;
  profileColor: ProfileColor | null;
  birthday: string | null;
}

export function publicProfile(u: {
  bio: string | null;
  avatarEmoji: string | null;
  profileColor: string | null;
  birthday: string | null;
}): PublicProfile {
  return {
    bio: u.bio ?? null,
    avatarEmoji: u.avatarEmoji ?? null,
    profileColor: isProfileColor(u.profileColor) ? u.profileColor : null,
    birthday: u.birthday && isBirthday(u.birthday) ? u.birthday : null,
  };
}
