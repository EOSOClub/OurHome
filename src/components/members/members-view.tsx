'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Copy,
  Crown,
  KeyRound,
  Loader2,
  Pencil,
  RefreshCw,
  Settings2,
  Trash2,
  UserPlus,
} from 'lucide-react';
import type { HouseholdMemberDTO } from '@/lib/types';
import { USER_ROLES, USER_ROLE_LABELS, type UserRole } from '@/lib/enums';
import { can, canAssignRole, canManageMember } from '@/lib/permissions';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { PermissionsCard } from '@/components/members/permissions-card';

const MEMBERS_KEY = ['members'];

type CurrentUser = { id: string; role: string };

const ROLE_BADGE: Record<UserRole, 'default' | 'warning' | 'secondary' | 'outline'> = {
  head: 'default',
  manager: 'warning',
  member: 'secondary',
  guest: 'outline',
};

/** A readable, copy-pasteable temporary password (>= 8 chars, alphanumeric). */
function generatePassword(): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return raw.slice(0, 12);
}

function assignableRoles(actorRole: string): UserRole[] {
  return USER_ROLES.filter(
    (r) => r !== 'head' && canAssignRole(actorRole, r),
  );
}

/** Copies `text` to the clipboard with a transient "Copied" state. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      disabled={!text}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error('Could not copy to the clipboard.');
        }
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

export function MembersView({
  initialMembers,
  householdName,
  currentUser,
}: {
  initialMembers: HouseholdMemberDTO[];
  householdName: string;
  currentUser: CurrentUser;
}) {
  const [renaming, setRenaming] = useState(false);
  const canRename = can(currentUser.role, 'household:manage');

  const { data: members = [] } = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: () => apiFetch<HouseholdMemberDTO[]>('/api/members'),
    initialData: initialMembers,
  });

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-1.5">
          <h1 className="text-2xl font-semibold">{householdName}</h1>
          {canRename ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label="Rename household"
              onClick={() => setRenaming(true)}
            >
              <Pencil className="size-4" />
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Add people to your household, set what they can do, and reset
          passwords. There is one Head of House at a time.
        </p>
      </div>

      <AddMemberCard actorRole={currentUser.role} />

      <ul className="space-y-3">
        {members.map((m) => (
          <MemberRow key={m.id} member={m} currentUser={currentUser} />
        ))}
      </ul>

      {/* Page permissions are the head's call (household:manage). */}
      {canRename ? (
        <PermissionsCard
          membersVersion={members.map((m) => `${m.id}:${m.role}`).join(',')}
        />
      ) : null}

      {renaming ? (
        <RenameHouseholdDialog
          current={householdName}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
}

function RenameHouseholdDialog({
  current,
  onClose,
}: {
  current: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(current);

  const rename = useMutation({
    mutationFn: (payload: { name: string }) =>
      apiFetch<{ id: string; name: string }>('/api/household/rename', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (household) => {
      toast.success(`Household renamed to “${household.name}”`);
      // The name is server-rendered on this page (and elsewhere); refresh it.
      router.refresh();
      onClose();
    },
  });

  const trimmed = name.trim();
  const canSubmit =
    trimmed.length > 0 && trimmed.length <= 80 && trimmed !== current;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename household"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={rename.isPending}>
            Cancel
          </Button>
          <Button
            disabled={rename.isPending || !canSubmit}
            onClick={() => rename.mutate({ name: trimmed })}
          >
            {rename.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit && !rename.isPending) rename.mutate({ name: trimmed });
        }}
        className="space-y-1.5"
      >
        <Label htmlFor="household-name">Household name</Label>
        <Input
          id="household-name"
          autoFocus
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">1–80 characters.</p>
      </form>
    </Dialog>
  );
}

function AddMemberCard({ actorRole }: { actorRole: string }) {
  const queryClient = useQueryClient();
  const roles = assignableRoles(actorRole);
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ name: string; username: string } | null>(
    null,
  );
  const [form, setForm] = useState({
    name: '',
    username: '',
    email: '',
    role: (roles.includes('member') ? 'member' : roles[0]) as UserRole,
    password: '',
  });

  const reset = () =>
    setForm({
      name: '',
      username: '',
      email: '',
      role: (roles.includes('member') ? 'member' : roles[0]) as UserRole,
      password: '',
    });

  const create = useMutation({
    mutationFn: (payload: typeof form) =>
      apiFetch<HouseholdMemberDTO>('/api/members', {
        method: 'POST',
        body: JSON.stringify({
          name: payload.name.trim(),
          username: payload.username.trim(),
          email: payload.email.trim() || undefined,
          role: payload.role,
          password: payload.password,
        }),
      }),
    onSuccess: (member) => {
      setCreated({ name: member.name, username: member.username ?? '' });
      reset();
      queryClient.invalidateQueries({ queryKey: MEMBERS_KEY });
    },
    // Errors surface via the global mutation-error toast.
  });

  const usernameTooShort =
    form.username.trim().length > 0 && form.username.trim().length < 3;
  const passwordTooShort =
    form.password.length > 0 && form.password.length < 8;
  const canSubmit =
    form.name.trim() && form.username.trim().length >= 3 && form.password.length >= 8;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="size-4" /> Add a member
          </CardTitle>
          <CardDescription>
            They sign in with a username and the temporary password you set, then
            choose their own.
          </CardDescription>
        </div>
        <Button
          variant={open ? 'ghost' : 'default'}
          size="sm"
          onClick={() => {
            setOpen((o) => !o);
            setCreated(null);
          }}
        >
          {open ? 'Close' : 'New member'}
        </Button>
      </CardHeader>

      {created ? (
        <CardContent>
          <div className="rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3 text-sm">
            Added <span className="font-medium">{created.name}</span>. They sign
            in with username{' '}
            <code className="rounded bg-background px-1">{created.username}</code>{' '}
            and the temporary password you set, then must change it.
          </div>
        </CardContent>
      ) : null}

      {open ? (
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) create.mutate(form);
            }}
            className="grid gap-3 sm:grid-cols-2"
          >
            <div className="space-y-1.5">
              <Label htmlFor="m-name">Name</Label>
              <Input
                id="m-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Jordan"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-username">Username</Label>
              <Input
                id="m-username"
                value={form.username}
                aria-describedby="m-username-hint"
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="e.g. jordan"
              />
              <p
                id="m-username-hint"
                className={
                  'text-xs ' +
                  (usernameTooShort ? 'text-destructive' : 'text-muted-foreground')
                }
              >
                At least 3 characters.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-email">Email (optional)</Label>
              <Input
                id="m-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="for password recovery"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-role">Role</Label>
              <Select
                id="m-role"
                value={form.role}
                onChange={(e) =>
                  setForm({ ...form, role: e.target.value as UserRole })
                }
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {USER_ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="m-password">Temporary password</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="m-password"
                  className="max-w-xs"
                  value={form.password}
                  aria-describedby="m-password-hint"
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="at least 8 characters"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setForm({ ...form, password: generatePassword() })}
                >
                  <RefreshCw className="size-4" /> Generate
                </Button>
                <CopyButton text={form.password} label="Copy temporary password" />
              </div>
              <p
                id="m-password-hint"
                className={
                  'text-xs ' +
                  (passwordTooShort ? 'text-destructive' : 'text-muted-foreground')
                }
              >
                At least 8 characters.
              </p>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={create.isPending || !canSubmit}>
                {create.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <UserPlus />
                )}
                Add member
              </Button>
            </div>
          </form>
        </CardContent>
      ) : null}
    </Card>
  );
}

function MemberRow({
  member,
  currentUser,
}: {
  member: HouseholdMemberDTO;
  currentUser: CurrentUser;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState({
    name: member.name,
    username: member.username ?? '',
    email: member.email,
  });
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState<null | 'head' | 'remove'>(null);
  const [pendingRole, setPendingRole] = useState<UserRole | null>(null);

  const isSelf = member.id === currentUser.id;
  const isHead = member.role === 'head';
  const manageable = canManageMember(currentUser.role, member.role);
  const roles = assignableRoles(currentUser.role);
  const canChangeRole = manageable && !isSelf && !isHead && roles.length > 0;
  const canResetPw = manageable && !isSelf;
  const canRemove = manageable && !isSelf && !isHead;
  const canTransfer = currentUser.role === 'head' && !isHead && !isSelf;
  const canEdit = isSelf || manageable;
  const showManage = canEdit || canChangeRole || canResetPw || canRemove || canTransfer;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: MEMBERS_KEY });

  const save = useMutation({
    mutationFn: () =>
      apiFetch<HouseholdMemberDTO>('/api/members/update', {
        method: 'POST',
        body: JSON.stringify({
          id: member.id,
          name: edit.name.trim(),
          username: edit.username.trim() || undefined,
          email: edit.email.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      toast.success(`Saved ${member.name}'s profile`);
      invalidate();
    },
  });

  const changeRole = useMutation({
    mutationFn: (role: UserRole) =>
      apiFetch<HouseholdMemberDTO>('/api/members/role', {
        method: 'POST',
        body: JSON.stringify({ id: member.id, role }),
      }),
    onSuccess: async (_updated, role) => {
      // Wait for the refetch so the select doesn't flash the old role.
      await invalidate();
      toast.success(`Changed ${member.name}'s role to ${USER_ROLE_LABELS[role]}`);
      setPendingRole(null);
    },
    onError: (err) => {
      // Revert the select to the member's real role.
      setPendingRole(null);
      toast.error(
        err instanceof ApiError ? err.message : 'Could not change the role.',
      );
    },
  });

  const resetPw = useMutation({
    mutationFn: () =>
      apiFetch<HouseholdMemberDTO>('/api/members/password', {
        method: 'POST',
        body: JSON.stringify({ id: member.id, password: newPassword }),
      }),
    onSuccess: () => {
      setNewPassword('');
      toast.success(`Password reset for ${member.name}`);
      invalidate();
    },
  });

  const makeHead = useMutation({
    mutationFn: () =>
      apiFetch<HouseholdMemberDTO>('/api/members/transfer-head', {
        method: 'POST',
        body: JSON.stringify({ id: member.id }),
      }),
    onSuccess: () => {
      toast.success(`${member.name} is now the Head of House`);
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>('/api/members/delete', {
        method: 'POST',
        body: JSON.stringify({ id: member.id }),
      }),
    onSuccess: () => {
      toast.success(`Removed ${member.name} from the household`);
      invalidate();
    },
  });

  const roleVariant = (USER_ROLES as readonly string[]).includes(member.role)
    ? ROLE_BADGE[member.role as UserRole]
    : 'secondary';

  return (
    <li className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          {member.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{member.name}</p>
            {isHead ? <Crown className="size-3.5 text-[var(--color-warning)]" /> : null}
            {isSelf ? (
              <span className="text-xs text-muted-foreground">(you)</span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {member.username ? `@${member.username}` : member.email}
          </p>
        </div>
        <Badge variant={roleVariant}>
          {USER_ROLE_LABELS[member.role as UserRole] ?? member.role}
        </Badge>
        {member.mustChangePassword ? (
          <Badge variant="warning" title="Will change password on next sign-in">
            Temp password
          </Badge>
        ) : null}
        {showManage ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-9 text-muted-foreground"
            aria-label={`Manage ${member.name}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <Settings2 />
          </Button>
        ) : null}
      </div>

      {open && showManage ? (
        <div className="space-y-4 border-t border-border px-4 py-4">
          {canEdit ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
              className="grid gap-3 sm:grid-cols-3"
            >
              <div className="space-y-1.5">
                <Label htmlFor={`name-${member.id}`}>Name</Label>
                <Input
                  id={`name-${member.id}`}
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`username-${member.id}`}>Username</Label>
                <Input
                  id={`username-${member.id}`}
                  value={edit.username}
                  onChange={(e) => setEdit({ ...edit, username: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`email-${member.id}`}>Email</Label>
                <Input
                  id={`email-${member.id}`}
                  type="email"
                  value={edit.email}
                  onChange={(e) => setEdit({ ...edit, email: e.target.value })}
                />
              </div>
              <div className="sm:col-span-3">
                <Button type="submit" size="sm" disabled={save.isPending}>
                  {save.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Pencil />
                  )}
                  Save profile
                </Button>
              </div>
            </form>
          ) : null}

          {canChangeRole ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor={`role-${member.id}`}>Role</Label>
                <Select
                  id={`role-${member.id}`}
                  className="w-44"
                  value={pendingRole ?? member.role}
                  disabled={changeRole.isPending}
                  onChange={(e) => {
                    const role = e.target.value as UserRole;
                    if (role !== member.role) setPendingRole(role);
                  }}
                >
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {USER_ROLE_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </div>
              {changeRole.isPending ? (
                <Loader2 className="mb-3 size-4 animate-spin text-muted-foreground" />
              ) : null}
            </div>
          ) : null}

          {canResetPw ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (newPassword.length >= 8) resetPw.mutate();
              }}
              className="space-y-1.5"
            >
              <Label htmlFor={`pw-${member.id}`}>Reset password</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id={`pw-${member.id}`}
                  className="max-w-xs"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="new temporary password"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setNewPassword(generatePassword())}
                >
                  <RefreshCw className="size-4" /> Generate
                </Button>
                <CopyButton text={newPassword} label="Copy new password" />
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={resetPw.isPending || newPassword.length < 8}
                >
                  {resetPw.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <KeyRound />
                  )}
                  Set password
                </Button>
              </div>
            </form>
          ) : null}

          {(canTransfer || canRemove) && (
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              {canTransfer ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={makeHead.isPending}
                  onClick={() => setConfirm('head')}
                >
                  {makeHead.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Crown />
                  )}
                  Make Head of House
                </Button>
              ) : null}
              {canRemove ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => setConfirm('remove')}
                >
                  {remove.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                  Remove
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm === 'head') makeHead.mutate();
          else if (confirm === 'remove') remove.mutate();
          setConfirm(null);
        }}
        title={confirm === 'head' ? 'Transfer Head of House' : 'Remove member'}
        description={
          confirm === 'head'
            ? `Make ${member.name} the Head of House? You'll become a Manager.`
            : `Remove ${member.name} from the household?`
        }
        confirmLabel={confirm === 'head' ? 'Make Head of House' : 'Remove'}
        destructive={confirm === 'remove'}
      />

      <ConfirmDialog
        open={pendingRole !== null}
        pending={changeRole.isPending}
        onClose={() => {
          if (!changeRole.isPending) setPendingRole(null);
        }}
        onConfirm={() => {
          if (pendingRole && !changeRole.isPending) changeRole.mutate(pendingRole);
        }}
        title="Change role"
        description={
          pendingRole
            ? `Change ${member.name}'s role to ${USER_ROLE_LABELS[pendingRole]}?`
            : undefined
        }
        confirmLabel="Change role"
      />
    </li>
  );
}
