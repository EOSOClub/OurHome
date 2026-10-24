import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REQUEST_MODULES,
  assigneeChoices,
  decidesRequest,
  enabledModules,
  handlesApproval,
  moduleLabel,
  moduleViews,
  parseRequestModules,
  requestModulesSchema,
  roleMayAsk,
  viewDecides,
  type RequestModuleSettings,
} from '@/lib/requestModules';

// Real-looking cuids: the schema checks the ids' shape.
const MOM = 'cmgabc0000000000000000001';
const DAD = 'cmgabc0000000000000000002';
const KID = 'cmgabc0000000000000000003';
const GONE = 'cmgabc0000000000000000009';

const withChanges = (changes: {
  media?: Partial<RequestModuleSettings['media']>;
  maintenance?: Partial<RequestModuleSettings['maintenance']>;
  purchase?: Partial<RequestModuleSettings['purchase']>;
  permission?: Partial<RequestModuleSettings['permission']>;
}): RequestModuleSettings => ({
  media: { ...DEFAULT_REQUEST_MODULES.media, ...changes.media },
  maintenance: { ...DEFAULT_REQUEST_MODULES.maintenance, ...changes.maintenance },
  purchase: { ...DEFAULT_REQUEST_MODULES.purchase, ...changes.purchase },
  permission: { ...DEFAULT_REQUEST_MODULES.permission, ...changes.permission },
});

const approve = (handlerIds: string[], bySupervisors = false) => ({ handlerIds, allowDecline: false, bySupervisors });

describe('parseRequestModules', () => {
  it('nothing stored: media and maintenance on, working as before', () => {
    for (const raw of [null, undefined, '', 'not json', '[]']) {
      const s = parseRequestModules(raw);
      expect(s).toEqual(DEFAULT_REQUEST_MODULES);
    }
    const s = parseRequestModules(null);
    expect(enabledModules(s)).toEqual(['media', 'maintenance']);
    expect(s.media.mediaTypes).toEqual(['movie', 'tv']);
    expect(s.media.handlerIds).toEqual([]);
    expect(s.media.allowDecline).toBe(false);
    expect(s.media.bySupervisors).toBe(false);
    expect(s.maintenance.requireDueDate).toBe(true);
    expect(s.maintenance.allowDecline).toBe(false);
    expect(s.maintenance.askRoles).toEqual(['head', 'manager', 'adult', 'teen', 'child', 'guest']);
  });

  it('purchase and permission start off, decided by supervisors first, always declinable', () => {
    const s = parseRequestModules(null);
    for (const m of [s.purchase, s.permission]) {
      expect(m.enabled).toBe(false);
      expect(m.bySupervisors).toBe(true);
      expect(m.allowDecline).toBe(true);
      expect(m.handlerIds).toEqual([]);
    }
    expect(s.purchase.askRoles).toEqual(['head', 'manager', 'adult', 'teen', 'child', 'guest']);
    expect(s.permission.askRoles).toEqual(['teen', 'child']);
  });

  it('a household saved before purchase and permission keeps its settings and gets their defaults', () => {
    const oldMedia: Partial<RequestModuleSettings['media']> = { ...DEFAULT_REQUEST_MODULES.media, label: 'Shows' };
    delete oldMedia.bySupervisors;
    const s = parseRequestModules(JSON.stringify({ media: oldMedia, maintenance: DEFAULT_REQUEST_MODULES.maintenance }));
    expect(s.media.label).toBe('Shows');
    expect(s.media.bySupervisors).toBe(false);
    expect(s.purchase).toEqual(DEFAULT_REQUEST_MODULES.purchase);
    expect(s.permission).toEqual(DEFAULT_REQUEST_MODULES.permission);
  });

  it('declining can’t be switched off for purchase or permission', () => {
    const s = parseRequestModules(JSON.stringify({ purchase: { enabled: true, allowDecline: false } }));
    expect(s.purchase.enabled).toBe(true);
    expect(s.purchase.allowDecline).toBe(true);
  });

  it('reads what the card saved', () => {
    const saved = withChanges({
      media: { label: 'Movies & TV', mediaTypes: ['tv'], allowDecline: true, handlerIds: [MOM] },
      maintenance: { enabled: false, requireDueDate: false, allowDecline: true, assigneeIds: [DAD], defaultAssigneeId: DAD },
    });
    expect(parseRequestModules(JSON.stringify(saved))).toEqual(saved);
  });

  it('a missing module or field keeps its default', () => {
    const s = parseRequestModules(JSON.stringify({ media: { enabled: false } }));
    expect(s.media).toEqual({ ...DEFAULT_REQUEST_MODULES.media, enabled: false });
    expect(s.maintenance).toEqual(DEFAULT_REQUEST_MODULES.maintenance);
  });

  it('a field that is no longer valid falls back alone', () => {
    const s = parseRequestModules(
      JSON.stringify({ media: { mediaTypes: ['vinyl'], label: 'Shows', unknown: 1 } }),
    );
    expect(s.media.mediaTypes).toEqual(['movie', 'tv']);
    expect(s.media.label).toBe('Shows');
    expect(s.media).not.toHaveProperty('unknown');
  });
});

describe('requestModulesSchema', () => {
  const valid = () => structuredClone(DEFAULT_REQUEST_MODULES);

  it('accepts the defaults', () => {
    expect(requestModulesSchema.safeParse(valid()).success).toBe(true);
  });

  it('blank name and note mean none', () => {
    const input = valid();
    input.media.label = '   ';
    input.media.note = '';
    const out = requestModulesSchema.parse(input);
    expect(out.media.label).toBeNull();
    expect(out.media.note).toBeNull();
  });

  it('needs at least one kind of media', () => {
    const input = valid();
    input.media.mediaTypes = [];
    expect(requestModulesSchema.safeParse(input).success).toBe(false);
  });

  it('the default person must be someone who can be asked', () => {
    const input = valid();
    input.maintenance.assigneeIds = [DAD];
    input.maintenance.defaultAssigneeId = MOM;
    expect(requestModulesSchema.safeParse(input).success).toBe(false);
    input.maintenance.assigneeIds = [];
    expect(requestModulesSchema.safeParse(input).success).toBe(true);
  });

  it('keeps roles and media types in their usual order, without repeats', () => {
    const input = valid();
    input.media.askRoles = ['child', 'head', 'child'];
    input.media.mediaTypes = ['tv', 'movie'];
    input.media.handlerIds = [MOM, MOM];
    const out = requestModulesSchema.parse(input);
    expect(out.media.askRoles).toEqual(['head', 'child']);
    expect(out.media.mediaTypes).toEqual(['movie', 'tv']);
    expect(out.media.handlerIds).toEqual([MOM]);
  });

  it('an older app sends only media and maintenance, without bySupervisors', () => {
    const media: Partial<RequestModuleSettings['media']> = { ...DEFAULT_REQUEST_MODULES.media };
    delete media.bySupervisors;
    const out = requestModulesSchema.parse({ media, maintenance: DEFAULT_REQUEST_MODULES.maintenance });
    expect(out.media.bySupervisors).toBe(false);
    expect(out.purchase).toBeUndefined();
    expect(out.permission).toBeUndefined();
  });

  it('media can’t be decided by supervisors; purchase and permission can’t turn declining off', () => {
    const media = valid();
    media.media.bySupervisors = true;
    expect(requestModulesSchema.safeParse(media).success).toBe(false);
    const purchase = valid();
    purchase.purchase.allowDecline = false;
    expect(requestModulesSchema.safeParse(purchase).success).toBe(false);
  });
});

describe('rules', () => {
  it('moduleLabel: the head’s name, else the built-in one', () => {
    expect(moduleLabel(DEFAULT_REQUEST_MODULES, 'media')).toBe('Media');
    expect(moduleLabel(withChanges({ media: { label: 'Movies & TV' } }), 'media')).toBe('Movies & TV');
  });

  it('roleMayAsk follows the role list', () => {
    const s = withChanges({ maintenance: { askRoles: ['head', 'adult'] } });
    expect(roleMayAsk(s.maintenance, 'adult')).toBe(true);
    expect(roleMayAsk(s.maintenance, 'child')).toBe(false);
  });

  it('handlesApproval: the Approve switch, unless people are chosen', () => {
    const members = new Set([MOM, DAD, KID]);
    expect(handlesApproval(approve([]), DAD, true, members)).toBe(true);
    expect(handlesApproval(approve([]), DAD, false, members)).toBe(false);
    expect(handlesApproval(approve([MOM]), DAD, true, members)).toBe(false);
    expect(handlesApproval(approve([MOM]), MOM, false, members)).toBe(true);
    // Everyone chosen has left: back to the switch, so requests never go unhandled.
    expect(handlesApproval(approve([GONE]), DAD, true, members)).toBe(true);
  });

  it('decidesRequest: the requester’s supervisors when that’s on and they have any', () => {
    const members = new Set([MOM, DAD, KID]);
    // KID is supervised by MOM; DAD has the Approve switch.
    expect(decidesRequest(approve([], true), MOM, false, members, [MOM])).toBe(true);
    expect(decidesRequest(approve([], true), DAD, true, members, [MOM])).toBe(false);
    // No supervisors (an adult asking), or only ones who have left: the usual people.
    expect(decidesRequest(approve([], true), DAD, true, members, [])).toBe(true);
    expect(decidesRequest(approve([], true), DAD, true, members, [GONE])).toBe(true);
    expect(decidesRequest(approve([], true), MOM, false, members, [])).toBe(false);
    // Off: supervisors don't matter.
    expect(decidesRequest(approve([], false), MOM, false, members, [MOM])).toBe(false);
    expect(decidesRequest(approve([], false), DAD, true, members, [MOM])).toBe(true);
  });

  it('assigneeChoices: chosen people still here, else everyone, never the requester', () => {
    const members = [MOM, DAD, KID];
    expect(assigneeChoices(DEFAULT_REQUEST_MODULES.maintenance, members, KID)).toEqual([MOM, DAD]);
    const s = withChanges({ maintenance: { assigneeIds: [DAD, GONE] } });
    expect(assigneeChoices(s.maintenance, members, KID)).toEqual([DAD]);
    expect(assigneeChoices(s.maintenance, members, DAD)).toEqual([]);
    const gone = withChanges({ maintenance: { assigneeIds: [GONE] } });
    expect(assigneeChoices(gone.maintenance, members, KID)).toEqual([MOM, DAD]);
  });
});

describe('moduleViews', () => {
  const members = [MOM, DAD, KID];

  it('defaults: what the page showed before modules', () => {
    const views = moduleViews(DEFAULT_REQUEST_MODULES, { id: KID, role: 'child' }, { create: true, approve: false }, members);
    expect(views.map((v) => [v.id, v.workflow, v.label, v.canAsk, v.handles])).toEqual([
      ['media', 'approve', 'Media', true, false],
      ['maintenance', 'assign', 'Maintenance', true, false],
    ]);
    expect(views[0].mediaTypes).toEqual(['movie', 'tv']);
    expect(views[1].assigneeIds).toEqual([MOM, DAD]);
    expect(views[1].requireDueDate).toBe(true);
  });

  it('only kinds that are on; asking needs the Add switch and the role', () => {
    const s = withChanges({ media: { enabled: false }, maintenance: { askRoles: ['head', 'adult'] } });
    const child = moduleViews(s, { id: KID, role: 'child' }, { create: true, approve: false }, members);
    expect(child.map((v) => v.id)).toEqual(['maintenance']);
    expect(child[0].canAsk).toBe(false);
    const adultNoAdd = moduleViews(s, { id: DAD, role: 'adult' }, { create: false, approve: false }, members);
    expect(adultNoAdd[0].canAsk).toBe(false);
  });

  it('the default person only when this member may ask them', () => {
    const s = withChanges({ maintenance: { defaultAssigneeId: DAD } });
    expect(moduleViews(s, { id: KID, role: 'child' }, { create: true, approve: false }, members)[1].defaultAssigneeId).toBe(DAD);
    expect(moduleViews(s, { id: DAD, role: 'adult' }, { create: true, approve: false }, members)[1].defaultAssigneeId).toBeNull();
  });

  it('handles media by chosen people when set', () => {
    const s = withChanges({ media: { handlerIds: [MOM], allowDecline: true } });
    const mom = moduleViews(s, { id: MOM, role: 'adult' }, { create: true, approve: false }, members)[0];
    const head = moduleViews(s, { id: DAD, role: 'head' }, { create: true, approve: true }, members)[0];
    expect([mom.handles, mom.allowDecline]).toEqual([true, true]);
    expect(head.handles).toBe(false);
  });

  it('maintenance declining follows its own switch, not media’s', () => {
    const off = withChanges({ media: { allowDecline: true } });
    expect(moduleViews(off, { id: KID, role: 'child' }, { create: true, approve: false }, members)[1].allowDecline).toBe(false);
    const on = withChanges({ maintenance: { allowDecline: true } });
    expect(moduleViews(on, { id: KID, role: 'child' }, { create: true, approve: false }, members)[1].allowDecline).toBe(true);
  });

  describe('purchase and permission', () => {
    const s = withChanges({ purchase: { enabled: true }, permission: { enabled: true } });
    const supervisors = new Map([[KID, [MOM, GONE]]]);
    const lists = [{ id: 'list1', name: 'Groceries' }];

    it('who decides what, from each side', () => {
      const mom = moduleViews(s, { id: MOM, role: 'adult' }, { create: true, approve: false }, members, { supervisors });
      const head = moduleViews(s, { id: DAD, role: 'head' }, { create: true, approve: true }, members, { supervisors });
      const permission = (views: typeof mom) => views.find((v) => v.id === 'permission')!;
      expect(permission(mom)).toMatchObject({ workflow: 'approve', bySupervisors: true, supervisedIds: [KID], supervisingIds: [KID], allowDecline: true });
      expect(permission(head).supervisingIds).toEqual([]);
      // MOM supervises KID; the head decides anyone without supervisors.
      expect([viewDecides(permission(mom), KID), viewDecides(permission(mom), DAD)]).toEqual([true, false]);
      expect([viewDecides(permission(head), KID), viewDecides(permission(head), MOM)]).toEqual([false, true]);
    });

    it('permission is for teens and children unless the head says otherwise', () => {
      const asks = (role: string) =>
        moduleViews(s, { id: KID, role }, { create: true, approve: false }, members).find((v) => v.id === 'permission')!.canAsk;
      expect([asks('child'), asks('teen'), asks('adult')]).toEqual([true, true, false]);
    });

    it('with the rule off, supervisors aren’t sent', () => {
      const off = withChanges({ purchase: { enabled: true, bySupervisors: false } });
      const view = moduleViews(off, { id: MOM, role: 'adult' }, { create: true, approve: false }, members, { supervisors })[2];
      expect(view.id).toBe('purchase');
      expect([view.bySupervisors, view.supervisedIds, view.supervisingIds]).toEqual([false, [], []]);
    });

    it('shopping lists go with purchase only', () => {
      const views = moduleViews(s, { id: DAD, role: 'head' }, { create: true, approve: true }, members, { shoppingLists: lists });
      expect(views.find((v) => v.id === 'purchase')!.shoppingLists).toEqual(lists);
      expect(views.filter((v) => v.id !== 'purchase').every((v) => v.shoppingLists.length === 0)).toBe(true);
    });
  });
});
