import { prisma } from '@/server/db/prisma';
import { ConflictError, NotFoundError } from '@/server/services/errors';
import type { UpdateProfileInput } from '@/lib/validation/user';
import { publicProfile, type PublicProfile } from '@/lib/profile';

export interface ProfileOverview {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: string;
  householdName: string | null;
  memberSince: string;
  /** About-me fields every member can see (src/lib/profile.ts). */
  profile: PublicProfile;
  stats: {
    tasksCompleted: number;
    openAssignedTasks: number;
    purchasesLogged: number;
  };
}

const ACTIVE_STATUSES = ['pending', 'in_progress'];

/**
 * Read-only account overview plus this user's activity stats. The editable
 * account fields (name, username, password) are mutated directly through the
 * Better Auth client on the profile page, so this service only reads.
 */
export async function getProfileOverview(
  userId: string,
): Promise<ProfileOverview> {
  const [user, tasksCompleted, openAssignedTasks, purchasesLogged] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          displayUsername: true,
          username: true,
          role: true,
          createdAt: true,
          bio: true,
          pronouns: true,
          avatarEmoji: true,
          profileColor: true,
          birthday: true,
          household: { select: { name: true } },
        },
      }),
      // Undone completions don't count (missed cycles have no user anyway).
      prisma.taskCompletion.count({
        where: { userId, OR: [{ undoneAt: null }, { undoneAt: { isSet: false } }] },
      }),
      prisma.task.count({
        where: { assigneeId: userId, status: { in: ACTIVE_STATUSES } },
      }),
      prisma.purchase.count({ where: { userId } }),
    ]);

  if (!user) throw new NotFoundError('User not found');

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.displayUsername ?? user.username ?? null,
    role: user.role,
    householdName: user.household?.name ?? null,
    memberSince: user.createdAt.toISOString(),
    profile: publicProfile(user),
    stats: { tasksCompleted, openAssignedTasks, purchasesLogged },
  };
}

/** Update the signed-in user's own name / username / email / about-me fields. */
export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<ProfileOverview> {
  const displayUsername = input.username?.trim();
  const username = displayUsername?.toLowerCase();
  const email = input.email?.trim().toLowerCase();

  if (username || email) {
    const or: { username?: string; email?: string }[] = [];
    if (username) or.push({ username });
    if (email) or.push({ email });
    const clash = await prisma.user.findFirst({
      where: { OR: or, NOT: { id: userId } },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictError('That username or email is already in use.');
    }
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      name: input.name?.trim() ?? undefined,
      username: username ?? undefined,
      displayUsername: displayUsername ?? undefined,
      email: email ?? undefined,
      // undefined = unchanged; null = cleared (the schema turns "" into null).
      bio: input.bio,
      pronouns: input.pronouns,
      avatarEmoji: input.avatarEmoji,
      profileColor: input.profileColor,
      birthday: input.birthday,
    },
  });

  return getProfileOverview(userId);
}

export interface HouseholdProfile extends PublicProfile {
  id: string;
  name: string;
  role: string;
}

/** Everyone in the household with their about-me fields, by name. */
export async function listHouseholdProfiles(householdId: string): Promise<HouseholdProfile[]> {
  const rows = await prisma.user.findMany({
    where: { householdId },
    select: {
      id: true,
      name: true,
      role: true,
      bio: true,
      pronouns: true,
      avatarEmoji: true,
      profileColor: true,
      birthday: true,
    },
    orderBy: { name: 'asc' },
  });
  return rows.map((u) => ({ id: u.id, name: u.name, role: u.role, ...publicProfile(u) }));
}

/**
 * Clear the temporary-password flag once the user has chosen their own
 * password. Called after a successful Better Auth changePassword.
 */
export async function clearMustChangePassword(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { mustChangePassword: false },
  });
}
