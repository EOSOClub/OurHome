import type { User } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { auth } from '@/server/auth/auth';
import { logActivity } from '@/server/services/activityService';
import {
  dropBrokenSupervision,
  linkNewSupervisors,
  newMemberSupervisors,
} from '@/server/services/supervisionService';
import { refreshPhoneAlerts } from '@/server/services/phoneStatusService';
import { ConflictError, ForbiddenError, NotFoundError } from '@/server/services/errors';
import { ROLE_RANK, USER_ROLE_LABELS, isUserRole, type UserRole } from '@/lib/enums';
import { can, canAssignRole, canManageMember } from '@/lib/permissions';
import type { HouseholdMemberDTO } from '@/lib/types';
import { PHONE_RULES, PHONE_RULE_COLUMNS, PHONE_RULE_LABELS, type PhoneRuleColumns } from '@/lib/phoneHealth';
import type {
  CreateMemberInput,
  ResetMemberPasswordInput,
  SetMemberRoleInput,
  UpdateMemberInput,
} from '@/lib/validation/user';

/** The acting user, as supplied by the authed route context. */
export interface Actor {
  id: string;
  role: string;
}

export function memberToDTO(u: User): HouseholdMemberDTO {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    username: u.displayUsername ?? u.username ?? null,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt.toISOString(),
  };
}

/** Members of a household, Head of House first, then by name. */
export async function listMembers(
  householdId: string,
): Promise<HouseholdMemberDTO[]> {
  const rows = await prisma.user.findMany({ where: { householdId } });
  return rows
    .sort((a, b) => {
      const ra = isUserRole(a.role) ? ROLE_RANK[a.role] : 0;
      const rb = isUserRole(b.role) ? ROLE_RANK[b.role] : 0;
      if (ra !== rb) return rb - ra;
      return a.name.localeCompare(b.name);
    })
    .map(memberToDTO);
}

async function loadMember(householdId: string, id: string): Promise<User> {
  const member = await prisma.user.findFirst({ where: { id, householdId } });
  if (!member) throw new NotFoundError(`Member ${id} not found.`);
  return member;
}

async function assertUnique(
  normalizedUsername: string | null,
  email: string | null,
  exceptUserId?: string,
): Promise<void> {
  const or: { username?: string; email?: string }[] = [];
  if (normalizedUsername) or.push({ username: normalizedUsername });
  if (email) or.push({ email });
  if (or.length === 0) return;
  const clash = await prisma.user.findFirst({
    where: { OR: or, NOT: exceptUserId ? { id: exceptUserId } : undefined },
    select: { id: true, username: true },
  });
  if (!clash) return;
  // Say which one, so the form marks that field.
  if (normalizedUsername && clash.username === normalizedUsername) {
    throw new ConflictError('That username is already taken. Try another.', 'username');
  }
  throw new ConflictError('That email is already used by another account.', 'email');
}

/**
 * Provision a household member with a temporary password. We create the user
 * row and credential account directly (rather than auth.api.signUpEmail) so the
 * call has no session/cookie side effects on the admin making the request.
 */
/**
 * A new child's phone choices as stored, the way People you look after stores
 * them (supervisionService): only a change from the default is written, so a
 * protection left on stays null (required). [said]: each change, for Activity.
 */
function setupChoices(setup: NonNullable<CreateMemberInput['setup']>) {
  const data: Partial<Pick<User, 'locationSharing' | 'shareAppUsage'> & PhoneRuleColumns> = {};
  const said: string[] = [];
  if (setup.locationRequired) {
    data.locationSharing = 'required';
    said.push('location sharing required');
  }
  if (setup.shareAppUsage) {
    data.shareAppUsage = true;
    said.push('app usage shared');
  }
  for (const rule of PHONE_RULES) {
    if (setup.rules[rule]) continue;
    data[PHONE_RULE_COLUMNS[rule]] = false;
    said.push(`${PHONE_RULE_LABELS[rule]} not required`);
  }
  return { data, said };
}

export async function createMember(
  householdId: string,
  actor: Actor,
  input: CreateMemberInput,
): Promise<HouseholdMemberDTO> {
  const role = input.role;
  if (role === 'head') {
    throw new ConflictError(
      'A household has one Head of House. Use “Make Head of House” to transfer it.',
    );
  }
  if (!canAssignRole(actor.role, role)) {
    throw new ForbiddenError('You cannot assign that role.');
  }

  const displayUsername = input.username.trim();
  const username = displayUsername.toLowerCase();
  const email = (input.email?.trim() || `${username}@household.local`).toLowerCase();
  await assertUnique(username, email);
  // Checked before anything is made, so a refusal leaves no half-set-up member.
  const supervisors = await newMemberSupervisors(householdId, actor, role, input.supervisorIds);
  // Their phone choices are a supervisor's to make, as on People you look after.
  if (input.setup && !supervisors.some((s) => s.id === actor.id)) {
    throw new ForbiddenError(
      'Only an adult who supervises them can choose their phone rules. Tick yourself under Who supervises them, or leave these to their supervisors.',
      'setup',
    );
  }
  const choices = input.setup ? setupChoices(input.setup) : null;

  const authCtx = await auth.$context;
  const hashed = await authCtx.password.hash(input.password);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: input.name.trim(),
        email,
        emailVerified: false,
        username,
        displayUsername,
        role,
        householdId,
        mustChangePassword: true,
        createdById: actor.id,
        ...choices?.data,
      },
    });
    await tx.account.create({
      data: {
        accountId: created.id,
        providerId: 'credential',
        userId: created.id,
        password: hashed,
      },
    });
    await linkNewSupervisors(tx, householdId, actor.id, created.id, supervisors);
    const lookedAfter =
      (supervisors.length ? `, supervised by ${supervisors.map((s) => s.name).join(', ')}` : '') +
      (choices?.said.length ? `; ${choices.said.join(', ')}` : '');
    await logActivity(
      {
        householdId,
        actorId: actor.id,
        verb: 'created',
        subjectType: 'member',
        subjectId: created.id,
        message: `added ${USER_ROLE_LABELS[role]} “${created.name}”${lookedAfter}`,
      },
      tx,
    );
    return created;
  });

  return memberToDTO(user);
}

/** Edit a member's profile fields. Self-edits are always allowed. */
export async function updateMember(
  householdId: string,
  actor: Actor,
  input: UpdateMemberInput,
): Promise<HouseholdMemberDTO> {
  const target = await loadMember(householdId, input.id);
  const isSelf = target.id === actor.id;
  if (!isSelf && !canManageMember(actor.role, target.role)) {
    throw new ForbiddenError('You cannot edit this member.');
  }

  const displayUsername = input.username?.trim();
  const username = displayUsername?.toLowerCase();
  const email = input.email?.trim().toLowerCase();
  // Password resets go to the email, so changing your own needs your password:
  // that check lives on the profile (updateProfile), not here.
  if (isSelf && email && email !== target.email.toLowerCase()) {
    throw new ForbiddenError('Change your own email from your profile.');
  }
  await assertUnique(username ?? null, email ?? null, target.id);

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      name: input.name?.trim() ?? undefined,
      username: username ?? undefined,
      displayUsername: displayUsername ?? undefined,
      email: email ?? undefined,
    },
  });

  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'updated',
    subjectType: 'member',
    subjectId: target.id,
    message: `updated ${updated.name}'s profile`,
  });

  return memberToDTO(updated);
}

/** Change a member's role (anything but head - headship moves via transfer). */
export async function setMemberRole(
  householdId: string,
  actor: Actor,
  input: SetMemberRoleInput,
): Promise<HouseholdMemberDTO> {
  if (input.id === actor.id) {
    throw new ForbiddenError('You cannot change your own role.');
  }
  const target = await loadMember(householdId, input.id);
  if (target.role === 'head') {
    throw new ConflictError('Transfer headship before changing the head’s role.');
  }
  if (input.role === 'head') {
    throw new ConflictError('Use “Make Head of House” to assign the head role.');
  }
  if (!canManageMember(actor.role, target.role) || !canAssignRole(actor.role, input.role)) {
    throw new ForbiddenError('You cannot assign that role.');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: target.id },
      data: { role: input.role },
    });
    // A kid who becomes an adult, or an adult who becomes a teen or guest,
    // leaves the supervision list.
    await dropBrokenSupervision(tx, u.id, u.role);
    await logActivity(
      {
        householdId,
        actorId: actor.id,
        verb: 'updated',
        subjectType: 'member',
        subjectId: target.id,
        message: `changed ${u.name}'s role to ${USER_ROLE_LABELS[input.role as UserRole]}`,
      },
      tx,
    );
    return u;
  });
  // Supervision may have changed with the role, so who gets phone alerts may too.
  await refreshPhoneAlerts(householdId);

  return memberToDTO(updated);
}

/**
 * Set a fresh temporary password for a member and require them to change it.
 * Existing sessions are revoked so the old password can't keep a session alive.
 */
export async function resetMemberPassword(
  householdId: string,
  actor: Actor,
  input: ResetMemberPasswordInput,
): Promise<HouseholdMemberDTO> {
  if (input.id === actor.id) {
    throw new ForbiddenError('Change your own password from your profile.');
  }
  const target = await loadMember(householdId, input.id);
  if (!canManageMember(actor.role, target.role)) {
    throw new ForbiddenError('You cannot reset this member’s password.');
  }

  const authCtx = await auth.$context;
  const hashed = await authCtx.password.hash(input.password);

  const updated = await prisma.$transaction(async (tx) => {
    const cred = await tx.account.findFirst({
      where: { userId: target.id, providerId: 'credential' },
      select: { id: true },
    });
    if (cred) {
      await tx.account.update({ where: { id: cred.id }, data: { password: hashed } });
    } else {
      await tx.account.create({
        data: {
          accountId: target.id,
          providerId: 'credential',
          userId: target.id,
          password: hashed,
        },
      });
    }
    await tx.session.deleteMany({ where: { userId: target.id } });
    const u = await tx.user.update({
      where: { id: target.id },
      data: { mustChangePassword: true },
    });
    await logActivity(
      {
        householdId,
        actorId: actor.id,
        verb: 'updated',
        subjectType: 'member',
        subjectId: target.id,
        message: `reset ${u.name}'s password`,
      },
      tx,
    );
    return u;
  });

  return memberToDTO(updated);
}

/** Remove a member from the household. The head cannot be removed directly. */
export async function removeMember(
  householdId: string,
  actor: Actor,
  id: string,
): Promise<void> {
  if (id === actor.id) {
    throw new ForbiddenError('You cannot remove yourself.');
  }
  const target = await loadMember(householdId, id);
  if (target.role === 'head') {
    throw new ConflictError('Transfer headship before removing the Head of House.');
  }
  if (!canManageMember(actor.role, target.role)) {
    throw new ForbiddenError('You cannot remove this member.');
  }

  await prisma.$transaction(async (tx) => {
    // Cascades remove sessions/accounts; assigned tasks are set null by schema.
    await tx.user.delete({ where: { id: target.id } });
    await logActivity(
      {
        householdId,
        actorId: actor.id,
        verb: 'deleted',
        subjectType: 'member',
        subjectId: target.id,
        message: `removed ${target.name} from the household`,
      },
      tx,
    );
  });
  // Alerts about their phone (or to them) have nobody left to be about.
  await refreshPhoneAlerts(householdId);
}

/** The household's display name (shown on the members page). */
export async function getHouseholdName(householdId: string): Promise<string> {
  const household = await prisma.household.findUnique({
    where: { id: householdId },
    select: { name: true },
  });
  if (!household) throw new NotFoundError('Household not found.');
  return household.name;
}

/** Rename the household. Requires household:manage (route-guarded; double-checked). */
export async function renameHousehold(
  householdId: string,
  actor: Actor,
  name: string,
): Promise<{ id: string; name: string }> {
  if (!can(actor.role, 'household:manage')) {
    throw new ForbiddenError('Only the Head of House can rename the household.');
  }
  const trimmed = name.trim();

  const updated = await prisma.$transaction(async (tx) => {
    const household = await tx.household.update({
      where: { id: householdId },
      data: { name: trimmed },
    });
    await logActivity(
      {
        householdId,
        actorId: actor.id,
        verb: 'updated',
        subjectType: 'household',
        subjectId: householdId,
        message: `renamed the household to “${trimmed}”`,
      },
      tx,
    );
    return household;
  });

  return { id: updated.id, name: updated.name };
}

/**
 * Hand the Head of House role to another member. Only the current head may do
 * this; they become a Manager so the single-head invariant holds.
 */
export async function transferHeadship(
  householdId: string,
  actor: Actor,
  newHeadId: string,
): Promise<HouseholdMemberDTO> {
  if (actor.role !== 'head') {
    throw new ForbiddenError('Only the Head of House can transfer headship.');
  }
  if (newHeadId === actor.id) {
    throw new ConflictError('You are already the Head of House.');
  }
  const target = await loadMember(householdId, newHeadId);

  const updated = await prisma.$transaction(async (tx) => {
    // Demote any current head(s) - there should be exactly one (the actor).
    await tx.user.updateMany({
      where: { householdId, role: 'head' },
      data: { role: 'manager' },
    });
    const u = await tx.user.update({
      where: { id: target.id },
      data: { role: 'head' },
    });
    // A teen or child made head is no longer supervised (the old head, now a
    // Manager, keeps supervising).
    await dropBrokenSupervision(tx, u.id, u.role);
    await logActivity(
      {
        householdId,
        actorId: actor.id,
        verb: 'updated',
        subjectType: 'member',
        subjectId: target.id,
        message: `made ${u.name} the Head of House`,
      },
      tx,
    );
    return u;
  });
  await refreshPhoneAlerts(householdId);

  return memberToDTO(updated);
}
