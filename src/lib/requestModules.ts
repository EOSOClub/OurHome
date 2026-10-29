// Request modules: the kinds of request a household can make (media,
// maintenance, ...). Each is built in here - its form and its workflow - and the
// Head of House turns it on and configures it in Settings → Request types.
// Households can't invent their own kinds: a fixed list keeps every request
// checkable on the server and drawable by the Android app.
//
// Two workflows so far:
//   approve: whoever handles the module (chosen people, or by default everyone
//            with the Requests "Approve" switch) marks it done in one step, or
//            declines it where the module allows that. Where the head chose
//            `bySupervisors`, a request from someone with supervisors (People
//            you look after) goes to those supervisors instead.
//   assign:  the requester asks one person, who accepts it (with a done-by
//            date unless the head made that optional) and later marks it done,
//            or declines it where the module allows that.
//
// Stored as JSON text in Household.requestModules. null, a missing module or a
// missing field means its default, so a household that never opened the card
// (or a module added later) works the way requests always did.
//
// Pure: shared by the server (services, routes) and the client (forms, card).

import { z } from 'zod';
import {
  MEDIA_TYPES,
  REQUEST_CATEGORIES,
  REQUEST_CATEGORY_LABELS,
  USER_ROLES,
  type MediaType,
  type RequestCategory,
  type UserRole,
} from '@/lib/enums';

export type RequestWorkflow = 'approve' | 'assign';

export const REQUEST_MODULE_WORKFLOWS: Record<RequestCategory, RequestWorkflow> = {
  media: 'approve',
  maintenance: 'assign',
  purchase: 'approve',
  permission: 'approve',
};

/** What each module is for, under its name on the Settings card. */
export const REQUEST_MODULE_DESCRIPTIONS: Record<RequestCategory, string> = {
  media: 'Movies and TV shows to get. Whoever approves them marks each one added.',
  maintenance:
    'Something to fix or do around the house. The person asked accepts it, then marks it done.',
  purchase:
    'Something someone would like bought. Whoever decides says yes or no, and can put it on a shopping list.',
  permission:
    'Asking to do something, like a sleepover or a new app. Whoever decides says yes or no.',
};

/** Modules that are always yes or no: declining is built in, not a switch. */
export const DECISION_MODULES: readonly RequestCategory[] = ['purchase', 'permission'];

export const REQUEST_MODULE_LIMITS = { label: 40, note: 300 } as const;

/** Every module has these. */
export interface CommonModuleSettings {
  enabled: boolean;
  /** The name shown on the Requests page; null = the built-in name. */
  label: string | null;
  /** Shown on the form once this kind is picked; null = nothing. */
  note: string | null;
  /** Roles that may ask (on top of the Requests "Add" switch). */
  askRoles: UserRole[];
}

/** Modules on the approve workflow. */
export interface ApproveModuleSettings {
  /** The people who handle it; empty = everyone with the Requests "Approve" switch. */
  handlerIds: string[];
  /** Whether those people may decline, with an optional reason. */
  allowDecline: boolean;
  /**
   * A request from someone with supervisors goes to their supervisors
   * instead; everyone else's to the people above. Media doesn't offer it.
   */
  bySupervisors: boolean;
}

export interface MediaModuleSettings extends CommonModuleSettings, ApproveModuleSettings {
  mediaTypes: MediaType[];
}

/** Purchase and Permission: yes or no, so `allowDecline` is always true. */
export type DecisionModuleSettings = CommonModuleSettings & ApproveModuleSettings;

export interface MaintenanceModuleSettings extends CommonModuleSettings {
  /** Who may be asked; empty = anyone in the household. */
  assigneeIds: string[];
  /** Picked for the requester to start with; null = nobody. */
  defaultAssigneeId: string | null;
  /** Accepting needs a done-by date (the deadline). Off: the date is optional. */
  requireDueDate: boolean;
  /** Whether the person asked may decline (before or after accepting), with an optional reason. */
  allowDecline: boolean;
}

export interface RequestModuleSettings {
  media: MediaModuleSettings;
  maintenance: MaintenanceModuleSettings;
  purchase: DecisionModuleSettings;
  permission: DecisionModuleSettings;
}

const COMMON_DEFAULTS: CommonModuleSettings = {
  enabled: true,
  label: null,
  note: null,
  askRoles: [...USER_ROLES],
};

// Purchase and Permission came later, so they start off: a household sees
// nothing new until the head turns them on.
const DECISION_DEFAULTS: DecisionModuleSettings = {
  ...COMMON_DEFAULTS,
  enabled: false,
  handlerIds: [],
  allowDecline: true,
  bySupervisors: true,
};

export const DEFAULT_REQUEST_MODULES: RequestModuleSettings = {
  media: {
    ...COMMON_DEFAULTS,
    handlerIds: [],
    allowDecline: false,
    bySupervisors: false,
    mediaTypes: [...MEDIA_TYPES],
  },
  maintenance: {
    ...COMMON_DEFAULTS,
    assigneeIds: [],
    defaultAssigneeId: null,
    requireDueDate: true,
    allowDecline: false,
  },
  purchase: DECISION_DEFAULTS,
  permission: { ...DECISION_DEFAULTS, askRoles: ['teen', 'child'] },
};

// --- Validation ---------------------------------------------------------------

/** Blank → null, so "no custom name" and "no note" are stored the same way. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => (s ? s : null));

const ids = z.array(z.cuid()).max(100).transform((list) => [...new Set(list)]);

const commonSchema = z.object({
  enabled: z.boolean(),
  label: optionalText(REQUEST_MODULE_LIMITS.label),
  note: optionalText(REQUEST_MODULE_LIMITS.note),
  askRoles: z
    .array(z.enum(USER_ROLES))
    .transform((list) => USER_ROLES.filter((r) => list.includes(r))),
});

const approveSchema = z.object({
  handlerIds: ids,
  allowDecline: z.boolean(),
  // App builds from before Purchase and Permission don't send it.
  bySupervisors: z.boolean().default(false),
});

export const mediaModuleSchema = commonSchema.extend(approveSchema.shape).extend({
  // Not offered for media.
  bySupervisors: z.literal(false).default(false),
  mediaTypes: z
    .array(z.enum(MEDIA_TYPES))
    .min(1, 'Offer at least one kind of media, or turn Media off.')
    .transform((list) => MEDIA_TYPES.filter((t) => list.includes(t))),
});

export const maintenanceModuleSchema = commonSchema
  .extend({
    assigneeIds: ids,
    defaultAssigneeId: z.cuid().nullable(),
    requireDueDate: z.boolean(),
    allowDecline: z.boolean(),
  })
  .superRefine((m, ctx) => {
    if (m.defaultAssigneeId && m.assigneeIds.length > 0 && !m.assigneeIds.includes(m.defaultAssigneeId)) {
      ctx.addIssue({
        code: 'custom',
        message: 'The default person must be one of the people who can be asked.',
        path: ['defaultAssigneeId'],
      });
    }
  });

export const decisionModuleSchema = commonSchema.extend(approveSchema.shape).extend({
  allowDecline: z.literal(true),
});

/**
 * What the Settings card sends: every module, every field. App builds from
 * before Purchase and Permission send only media and maintenance; the service
 * keeps the stored settings of a module that isn't sent.
 */
export const requestModulesSchema = z.object({
  media: mediaModuleSchema,
  maintenance: maintenanceModuleSchema,
  purchase: decisionModuleSchema.optional(),
  permission: decisionModuleSchema.optional(),
});

export type RequestModulesInput = z.infer<typeof requestModulesSchema>;

/**
 * One module's stored settings over its defaults. All of it when it's valid;
 * otherwise field by field, so one field that's no longer valid falls back to
 * its default without losing the rest.
 */
function readModule<T extends object>(defaults: T, saved: unknown, schema: z.ZodType<T>): T {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaults;
  const known = Object.fromEntries(Object.entries(saved).filter(([key]) => key in defaults));
  const whole = schema.safeParse({ ...defaults, ...known });
  if (whole.success) return whole.data;
  let merged: T = defaults;
  for (const [key, value] of Object.entries(known)) {
    const candidate = schema.safeParse({ ...merged, [key]: value });
    if (candidate.success) merged = candidate.data;
  }
  return merged;
}

/** The stored JSON text → every module's settings (null or unreadable: defaults). */
export function parseRequestModules(raw: string | null | undefined): RequestModuleSettings {
  let stored: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
    } catch {
      // Unreadable: all defaults.
    }
  }
  return {
    media: readModule(DEFAULT_REQUEST_MODULES.media, stored.media, mediaModuleSchema),
    maintenance: readModule(DEFAULT_REQUEST_MODULES.maintenance, stored.maintenance, maintenanceModuleSchema),
    purchase: readModule(DEFAULT_REQUEST_MODULES.purchase, stored.purchase, decisionModuleSchema),
    permission: readModule(DEFAULT_REQUEST_MODULES.permission, stored.permission, decisionModuleSchema),
  };
}

// --- Rules ------------------------------------------------------------------

export function moduleLabel(settings: RequestModuleSettings, id: RequestCategory): string {
  return settings[id].label ?? REQUEST_CATEGORY_LABELS[id];
}

export function enabledModules(settings: RequestModuleSettings): RequestCategory[] {
  return REQUEST_CATEGORIES.filter((id) => settings[id].enabled);
}

export function isRequestCategory(value: string): value is RequestCategory {
  return (REQUEST_CATEGORIES as readonly string[]).includes(value);
}

/** A module's approve-workflow settings (who handles it, declining), or null on another workflow. */
export function approveSettings(settings: RequestModuleSettings, id: RequestCategory): ApproveModuleSettings | null {
  return REQUEST_MODULE_WORKFLOWS[id] === 'approve' ? (settings[id] as unknown as ApproveModuleSettings) : null;
}

/** The module's role list allows this role to ask. */
export function roleMayAsk(settings: CommonModuleSettings, role: string): boolean {
  return (settings.askRoles as readonly string[]).includes(role);
}

/**
 * Whether `userId` handles an approve-workflow module: one of its chosen
 * people, or - when none are chosen, or none of them is still in the household
 * - anyone with the Requests "Approve" switch (`approveSwitch`).
 */
export function handlesApproval(
  settings: ApproveModuleSettings,
  userId: string,
  approveSwitch: boolean,
  memberIds: ReadonlySet<string>,
): boolean {
  const chosen = settings.handlerIds.filter((id) => memberIds.has(id));
  return chosen.length > 0 ? chosen.includes(userId) : approveSwitch;
}

/**
 * Whether `userId` decides one approve-workflow request: with `bySupervisors`,
 * a requester who has supervisors (`requesterSupervisorIds`, still in the
 * household) is decided by those supervisors only; anyone else's request by
 * handlesApproval's people.
 */
export function decidesRequest(
  settings: ApproveModuleSettings,
  userId: string,
  approveSwitch: boolean,
  memberIds: ReadonlySet<string>,
  requesterSupervisorIds: readonly string[],
): boolean {
  if (settings.bySupervisors) {
    const supervisors = requesterSupervisorIds.filter((id) => memberIds.has(id));
    if (supervisors.length > 0) return supervisors.includes(userId);
  }
  return handlesApproval(settings, userId, approveSwitch, memberIds);
}

/**
 * The same decision from a member's module view, as the Requests page and the
 * Android app make it for each request on the page.
 */
export function viewDecides(
  view: Pick<RequestModuleView, 'handles' | 'bySupervisors' | 'supervisedIds' | 'supervisingIds'>,
  requesterId: string,
): boolean {
  if (view.bySupervisors && view.supervisedIds.includes(requesterId)) return view.supervisingIds.includes(requesterId);
  return view.handles;
}

/**
 * The people a maintenance request may go to: the chosen ones still in the
 * household (everyone when none are), never the requester.
 */
export function assigneeChoices(
  settings: MaintenanceModuleSettings,
  memberIds: readonly string[],
  requesterId: string,
): string[] {
  const chosen = settings.assigneeIds.filter((id) => memberIds.includes(id));
  return (chosen.length > 0 ? chosen : memberIds).filter((id) => id !== requesterId);
}

/**
 * One module as a member sees it: what the form offers them and what they
 * handle. The Requests page and the Android app draw from this
 * (GET /api/requests/modules). Only modules that are on are sent.
 */
export interface RequestModuleView {
  id: RequestCategory;
  workflow: RequestWorkflow;
  label: string;
  note: string | null;
  /** May ask: the Requests "Add" switch and the module's roles. */
  canAsk: boolean;
  /**
   * Approve workflow: marks these done (and declines, where allowed). With
   * `bySupervisors`, only the requests of people without supervisors; use
   * viewDecides for one request.
   */
  handles: boolean;
  /** Approve workflow: a request from someone with supervisors goes to them. */
  bySupervisors: boolean;
  /** With bySupervisors: the members who have supervisors. Empty otherwise. */
  supervisedIds: string[];
  /** With bySupervisors: those of them this member supervises. Empty otherwise. */
  supervisingIds: string[];
  /**
   * Purchase: the shopping lists this member may put an approved purchase on
   * (empty when they can't add to shopping). Empty for other modules.
   */
  shoppingLists: { id: string; name: string }[];
  /** Whoever handles one may decline it: approve workflow, the handlers; assign workflow, the person asked. */
  allowDecline: boolean;
  /** Media: the kinds offered. Empty for other modules. */
  mediaTypes: MediaType[];
  /** Assign workflow: who this member may ask. Empty for other modules. */
  assigneeIds: string[];
  /** Assign workflow: picked to start with, when it's one of assigneeIds. */
  defaultAssigneeId: string | null;
  /** Assign workflow: accepting needs a done-by date. */
  requireDueDate: boolean;
}

/**
 * `supervisors`: each supervised member's supervisors (for bySupervisors).
 * `shoppingLists`: the lists the viewer may add to (Purchase), empty when they
 * can't add to shopping.
 */
export function moduleViews(
  settings: RequestModuleSettings,
  viewer: { id: string; role: string },
  access: { create: boolean; approve: boolean },
  memberIds: readonly string[],
  extra: {
    supervisors?: ReadonlyMap<string, readonly string[]>;
    shoppingLists?: { id: string; name: string }[];
  } = {},
): RequestModuleView[] {
  const members = new Set(memberIds);
  // Members with at least one supervisor still here, and which of them the viewer supervises.
  const supervisedIds: string[] = [];
  const supervisingIds: string[] = [];
  for (const [kid, sups] of extra.supervisors ?? []) {
    if (!members.has(kid)) continue;
    const here = sups.filter((s) => members.has(s));
    if (here.length === 0) continue;
    supervisedIds.push(kid);
    if (here.includes(viewer.id)) supervisingIds.push(kid);
  }
  const none = {
    bySupervisors: false,
    supervisedIds: [],
    supervisingIds: [],
    shoppingLists: [],
    mediaTypes: [],
    assigneeIds: [],
    defaultAssigneeId: null,
    requireDueDate: false,
  };
  return enabledModules(settings).map((id): RequestModuleView => {
    const common = {
      ...none,
      id,
      workflow: REQUEST_MODULE_WORKFLOWS[id],
      label: moduleLabel(settings, id),
      note: settings[id].note,
      canAsk: access.create && roleMayAsk(settings[id], viewer.role),
    };
    if (id === 'maintenance') {
      const m = settings.maintenance;
      const choices = assigneeChoices(m, memberIds, viewer.id);
      return {
        ...common,
        handles: false,
        allowDecline: m.allowDecline,
        assigneeIds: choices,
        defaultAssigneeId: m.defaultAssigneeId && choices.includes(m.defaultAssigneeId) ? m.defaultAssigneeId : null,
        requireDueDate: m.requireDueDate,
      };
    }
    const m = settings[id];
    return {
      ...common,
      handles: handlesApproval(m, viewer.id, access.approve, members),
      allowDecline: m.allowDecline,
      bySupervisors: m.bySupervisors,
      supervisedIds: m.bySupervisors ? supervisedIds : [],
      supervisingIds: m.bySupervisors ? supervisingIds : [],
      shoppingLists: id === 'purchase' ? (extra.shoppingLists ?? []) : [],
      mediaTypes: id === 'media' ? settings.media.mediaTypes : [],
    };
  });
}
