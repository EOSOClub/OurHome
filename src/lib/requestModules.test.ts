import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REQUEST_MODULES,
  assigneeChoices,
  enabledModules,
  handlesApproval,
  moduleLabel,
  moduleViews,
  parseRequestModules,
  requestModulesSchema,
  roleMayAsk,
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
}): RequestModuleSettings => ({
  media: { ...DEFAULT_REQUEST_MODULES.media, ...changes.media },
  maintenance: { ...DEFAULT_REQUEST_MODULES.maintenance, ...changes.maintenance },
});

describe('parseRequestModules', () => {
  it('nothing stored: both kinds on, working as before', () => {
    for (const raw of [null, undefined, '', 'not json', '[]']) {
      const s = parseRequestModules(raw);
      expect(s).toEqual(DEFAULT_REQUEST_MODULES);
    }
    const s = parseRequestModules(null);
    expect(enabledModules(s)).toEqual(['media', 'maintenance']);
    expect(s.media.mediaTypes).toEqual(['movie', 'tv']);
    expect(s.media.handlerIds).toEqual([]);
    expect(s.media.allowDecline).toBe(false);
    expect(s.maintenance.requireDueDate).toBe(true);
    expect(s.maintenance.allowDecline).toBe(false);
    expect(s.maintenance.askRoles).toEqual(['head', 'manager', 'adult', 'teen', 'child', 'guest']);
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
    expect(handlesApproval({ handlerIds: [], allowDecline: false }, DAD, true, members)).toBe(true);
    expect(handlesApproval({ handlerIds: [], allowDecline: false }, DAD, false, members)).toBe(false);
    expect(handlesApproval({ handlerIds: [MOM], allowDecline: false }, DAD, true, members)).toBe(false);
    expect(handlesApproval({ handlerIds: [MOM], allowDecline: false }, MOM, false, members)).toBe(true);
    // Everyone chosen has left: back to the switch, so requests never go unhandled.
    expect(handlesApproval({ handlerIds: [GONE], allowDecline: false }, DAD, true, members)).toBe(true);
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
});
