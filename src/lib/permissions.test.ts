import { describe, expect, it } from 'vitest';
import {
  can,
  canAssignRole,
  canManageMember,
  PERMISSIONS,
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

  it('limits members to feature writes, not administration', () => {
    expect(can('member', 'bills:write')).toBe(true);
    expect(can('member', 'shopping:write')).toBe(true);
    expect(can('member', 'members:manage')).toBe(false);
    expect(can('member', 'settings:manage')).toBe(false);
  });

  it('reserves task create/edit/delete for the head', () => {
    expect(can('head', 'tasks:write')).toBe(true);
    for (const r of ['manager', 'member', 'guest']) {
      expect(can(r, 'tasks:write')).toBe(false);
      // Everyone else still works tasks: complete them and tick checklist items.
      expect(can(r, 'tasks:complete')).toBe(true);
    }
  });

  it('lets every role make requests', () => {
    for (const r of ['head', 'manager', 'member', 'guest']) {
      expect(can(r, 'requests:write')).toBe(true);
    }
  });

  it('lets everyone report bugs but only the head receive them', () => {
    expect(can('head', 'bugs:manage')).toBe(true);
    for (const r of ['head', 'manager', 'member', 'guest']) {
      expect(can(r, 'bugs:report')).toBe(true);
    }
    for (const r of ['manager', 'member', 'guest']) {
      expect(can(r, 'bugs:manage')).toBe(false);
    }
  });

  it('reserves handling media requests for the head', () => {
    expect(can('head', 'requests:manage_media')).toBe(true);
    for (const r of ['manager', 'member', 'guest']) {
      expect(can(r, 'requests:manage_media')).toBe(false);
    }
  });

  it('limits guests to completing tasks and making requests', () => {
    expect(can('guest', 'tasks:complete')).toBe(true);
    expect(can('guest', 'tasks:write')).toBe(false);
    expect(can('guest', 'shopping:write')).toBe(false);
  });

  it('grants nothing to unknown roles', () => {
    expect(can('admin', 'tasks:write')).toBe(false);
    expect(can('', 'tasks:complete')).toBe(false);
  });
});

describe('canManageMember', () => {
  it('lets the head manage anyone', () => {
    for (const r of ['head', 'manager', 'member', 'guest']) {
      expect(canManageMember('head', r)).toBe(true);
    }
  });

  it('lets managers manage only members and guests', () => {
    expect(canManageMember('manager', 'member')).toBe(true);
    expect(canManageMember('manager', 'guest')).toBe(true);
    expect(canManageMember('manager', 'manager')).toBe(false);
    expect(canManageMember('manager', 'head')).toBe(false);
  });

  it('denies members and guests', () => {
    expect(canManageMember('member', 'guest')).toBe(false);
    expect(canManageMember('guest', 'guest')).toBe(false);
  });
});

describe('canAssignRole', () => {
  it('never assigns head (use transfer headship)', () => {
    expect(canAssignRole('head', 'head')).toBe(false);
    expect(canAssignRole('manager', 'head')).toBe(false);
  });

  it('lets the head assign manager/member/guest', () => {
    expect(canAssignRole('head', 'manager')).toBe(true);
    expect(canAssignRole('head', 'member')).toBe(true);
    expect(canAssignRole('head', 'guest')).toBe(true);
  });

  it('lets managers assign only member/guest', () => {
    expect(canAssignRole('manager', 'member')).toBe(true);
    expect(canAssignRole('manager', 'guest')).toBe(true);
    expect(canAssignRole('manager', 'manager')).toBe(false);
  });
});
