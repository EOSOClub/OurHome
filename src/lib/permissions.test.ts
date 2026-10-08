import { describe, expect, it } from 'vitest';
import { USER_ROLES } from '@/lib/enums';
import {
  ACCESS_PAGES,
  PAGE_ACTIONS,
  BUILTIN_ROLE_ACCESS,
  FULL_ACCESS,
  can,
  canAssignRole,
  canManageMember,
  canModify,
  diffAccess,
  hasAnyAccess,
  parseStoredJson,
  PERMISSIONS,
  resolveAccess,
  roleAccessOverridesSchema,
  roleDefaultAccess,
  type AccessMatrix,
  type AccessPage,
  type PageAccess,
} from '@/lib/permissions';

describe('can', () => {
  it('grants the head every permission', () => {
    for (const p of PERMISSIONS) expect(can('head', p)).toBe(true);
  });

  it('lets managers manage members and settings but not the household', () => {
    expect(can('manager', 'members:manage')).toBe(true);
    expect(can('manager', 'settings:manage')).toBe(true);
    expect(can('manager', 'household:manage')).toBe(false);
  });

  it('keeps members out of administration', () => {
    expect(can('member', 'members:manage')).toBe(false);
    expect(can('member', 'settings:manage')).toBe(false);
  });

  it('lets every role complete tasks', () => {
    for (const r of USER_ROLES) {
      expect(can(r, 'tasks:complete')).toBe(true);
    }
  });

  it('lets every role make requests', () => {
    for (const r of USER_ROLES) {
      expect(can(r, 'requests:write')).toBe(true);
    }
  });

  it('lets everyone report bugs but only the head receive them', () => {
    expect(can('head', 'bugs:manage')).toBe(true);
    for (const r of USER_ROLES) {
      expect(can(r, 'bugs:report')).toBe(true);
    }
    for (const r of USER_ROLES.filter((r) => r !== 'head')) {
      expect(can(r, 'bugs:manage')).toBe(false);
    }
  });

  it('keeps teens, children and guests out of administration', () => {
    for (const r of ['teen', 'child', 'guest']) {
      expect(can(r, 'members:manage')).toBe(false);
      expect(can(r, 'settings:manage')).toBe(false);
    }
  });

  it('grants nothing to unknown roles', () => {
    expect(can('admin', 'tasks:complete')).toBe(false);
    expect(can('', 'tasks:complete')).toBe(false);
  });
});

describe('canManageMember', () => {
  it('lets the head manage anyone', () => {
    for (const r of ['head', 'manager', 'member', 'guest']) {
      expect(canManageMember('head', r)).toBe(true);
    }
  });

  it('lets managers manage only the ranks below them', () => {
    for (const r of ['member', 'teen', 'child', 'guest']) {
      expect(canManageMember('manager', r)).toBe(true);
    }
    expect(canManageMember('manager', 'manager')).toBe(false);
    expect(canManageMember('manager', 'head')).toBe(false);
  });

  it('denies members, teens and guests', () => {
    expect(canManageMember('member', 'guest')).toBe(false);
    expect(canManageMember('member', 'child')).toBe(false);
    expect(canManageMember('teen', 'child')).toBe(false);
    expect(canManageMember('guest', 'guest')).toBe(false);
  });
});

describe('canAssignRole', () => {
  it('never assigns head (use transfer headship)', () => {
    expect(canAssignRole('head', 'head')).toBe(false);
    expect(canAssignRole('manager', 'head')).toBe(false);
  });

  it('lets the head assign every role but head', () => {
    for (const r of ['manager', 'member', 'teen', 'child', 'guest']) {
      expect(canAssignRole('head', r)).toBe(true);
    }
  });

  it('lets managers assign only the ranks below them', () => {
    for (const r of ['member', 'teen', 'child', 'guest']) {
      expect(canAssignRole('manager', r)).toBe(true);
    }
    expect(canAssignRole('manager', 'manager')).toBe(false);
  });
});

const page = (over: Partial<PageAccess> = {}): PageAccess => ({
  create: false,
  editOwn: false,
  deleteOwn: false,
  editOthers: false,
  deleteOthers: false,
  approve: false,
  ...over,
});

/** Only the switches that mean something on `p` (PAGE_ACTIONS). */
function shown(access: AccessMatrix, p: AccessPage): Partial<PageAccess> {
  return Object.fromEntries(PAGE_ACTIONS[p].map((a) => [a, access[p][a]]));
}

describe('resolveAccess', () => {
  it('gives the head everything, ignoring any overrides', () => {
    expect(
      resolveAccess('head', { manager: { tasks: { create: false } } }, {
        tasks: { create: false },
      }),
    ).toEqual(FULL_ACCESS);
  });

  it('defaults to the old behaviour: tasks head-only, guests read-only', () => {
    const everything = {
      create: true, editOwn: true, deleteOwn: true, editOthers: true, deleteOthers: true,
    };
    for (const r of ['manager', 'member'] as const) {
      const a = resolveAccess(r, null, null);
      expect(hasAnyAccess(a.tasks)).toBe(false);
      for (const p of ['calendar', 'shopping', 'shoppingLists', 'inventory', 'bills'] as const) {
        expect(shown(a, p)).toEqual(everything);
      }
    }
    const guest = resolveAccess('guest', null, null);
    for (const p of ACCESS_PAGES) {
      if (p !== 'requests') expect(hasAnyAccess(guest[p])).toBe(false);
    }
  });

  it('gives teens their own calendar, shopping and inventory entries', () => {
    const teen = resolveAccess('teen', null, null);
    const own = { create: true, editOwn: true, deleteOwn: true, editOthers: false, deleteOthers: false };
    for (const p of ['calendar', 'shopping', 'inventory'] as const) {
      expect(shown(teen, p)).toEqual(own);
    }
    for (const p of ['tasks', 'shoppingLists', 'bills'] as const) {
      expect(hasAnyAccess(teen[p])).toBe(false);
    }
  });

  it('lets children only add shopping items (and tick them off)', () => {
    const child = resolveAccess('child', null, null);
    expect(child.shopping).toEqual(page({ create: true }));
    expect(hasAnyAccess(child.shopping)).toBe(true);
    for (const p of ['tasks', 'calendar', 'shoppingLists', 'inventory', 'bills'] as const) {
      expect(hasAnyAccess(child[p])).toBe(false);
    }
  });

  it('lets every role submit requests; only managers approve media by default', () => {
    for (const r of ['member', 'teen', 'child', 'guest'] as const) {
      expect(resolveAccess(r, null, null).requests).toEqual(page({ create: true }));
    }
    expect(resolveAccess('manager', null, null).requests).toEqual(
      page({ create: true, approve: true }),
    );
    expect(resolveAccess('head', null, null).requests.approve).toBe(true);
  });

  it('can grant media approval to one member', () => {
    expect(
      resolveAccess('member', null, { requests: { approve: true } }).requests.approve,
    ).toBe(true);
  });

  it('can switch request submission off for one member', () => {
    expect(
      resolveAccess('member', null, { requests: { create: false } }).requests.create,
    ).toBe(false);
  });

  it('layers built-in, then household role edits, then the member', () => {
    const a = resolveAccess(
      'member',
      { member: { tasks: { create: true, editOwn: true }, bills: { deleteOthers: false } } },
      { tasks: { editOwn: false }, shopping: { create: false } },
    );
    expect(a.tasks).toEqual(page({ create: true }));
    expect(a.bills.deleteOthers).toBe(false);
    expect(a.bills.create).toBe(true);
    expect(a.shopping.create).toBe(false);
    expect(a.shopping.editOthers).toBe(true);
  });

  it('only applies role edits to that role', () => {
    const edits = { manager: { tasks: { create: true } } };
    expect(resolveAccess('manager', edits, null).tasks.create).toBe(true);
    expect(resolveAccess('member', edits, null).tasks.create).toBe(false);
  });

  it('grants nothing to unknown roles', () => {
    const a = resolveAccess('admin', null, { tasks: { create: true } });
    for (const p of ACCESS_PAGES) expect(hasAnyAccess(a[p])).toBe(false);
  });
});

describe('canModify', () => {
  const ownOnly = page({ editOwn: true, deleteOwn: true });
  const othersOnly = page({ editOthers: true, deleteOthers: true });

  it('uses the own toggles for records the user created', () => {
    expect(canModify(ownOnly, 'edit', 'u1', 'u1')).toBe(true);
    expect(canModify(ownOnly, 'delete', 'u1', 'u1')).toBe(true);
    expect(canModify(othersOnly, 'edit', 'u1', 'u1')).toBe(false);
  });

  it("uses the others' toggles for someone else's records", () => {
    expect(canModify(ownOnly, 'edit', 'u2', 'u1')).toBe(false);
    expect(canModify(othersOnly, 'edit', 'u2', 'u1')).toBe(true);
    expect(canModify(othersOnly, 'delete', 'u2', 'u1')).toBe(true);
  });

  it("treats a record with no creator as someone else's", () => {
    expect(canModify(ownOnly, 'edit', null, 'u1')).toBe(false);
    expect(canModify(othersOnly, 'delete', null, 'u1')).toBe(true);
  });

  it('keeps edit and delete separate', () => {
    const editOnly = page({ editOwn: true });
    expect(canModify(editOnly, 'edit', 'u1', 'u1')).toBe(true);
    expect(canModify(editOnly, 'delete', 'u1', 'u1')).toBe(false);
  });
});

describe('diffAccess', () => {
  it('stores only the cells that changed', () => {
    const base = roleDefaultAccess('member', null);
    const next: AccessMatrix = structuredClone(base);
    next.tasks.create = true;
    next.bills.deleteOthers = false;
    expect(diffAccess(base, next)).toEqual({
      tasks: { create: true },
      bills: { deleteOthers: false },
    });
    expect(diffAccess(base, base)).toEqual({});
  });

  it('round-trips through resolveAccess', () => {
    const base = BUILTIN_ROLE_ACCESS.guest;
    const next: AccessMatrix = structuredClone(base);
    for (const a of PAGE_ACTIONS.shopping) next.shopping[a] = true;
    next.requests.approve = true;
    expect(resolveAccess('guest', null, diffAccess(base, next))).toEqual(next);
  });
});

describe('parseStoredJson', () => {
  it('reads valid JSON and ignores junk', () => {
    expect(
      parseStoredJson('{"member":{"tasks":{"create":true}}}', roleAccessOverridesSchema),
    ).toEqual({ member: { tasks: { create: true } } });
    expect(parseStoredJson('not json', roleAccessOverridesSchema)).toBeNull();
    expect(parseStoredJson('{"member":{"tasks":{"create":"yes"}}}', roleAccessOverridesSchema)).toBeNull();
    expect(parseStoredJson(null, roleAccessOverridesSchema)).toBeNull();
  });
});
