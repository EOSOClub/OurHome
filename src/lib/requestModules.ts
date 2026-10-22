// Request modules: the kinds of request a household can make (media,
// maintenance, ...). Each is built in here - its form and its workflow - and the
// Head of House turns it on and configures it in Settings → Request types.
// Households can't invent their own kinds: a fixed list keeps every request
// checkable on the server and drawable by the Android app.
//
// Two workflows so far:
//   approve: whoever handles the module (chosen people, or by default everyone
//            with the Requests "Approve" switch) marks it done in one step, or
//            declines it where the module allows that.
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
};

/** What each module is for, under its name on the Settings card. */
export const REQUEST_MODULE_DESCRIPTIONS: Record<RequestCategory, string> = {
  media: 'Movies and TV shows to get. Whoever approves them marks each one added.',
  maintenance:
    'Something to fix or do around the house. The person asked accepts it, then marks it done.',
};

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
}

export interface MediaModuleSettings extends CommonModuleSettings, ApproveModuleSettings {
  mediaTypes: MediaType[];
}

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
}

const COMMON_DEFAULTS: CommonModuleSettings = {
  enabled: true,
  label: null,
  note: null,
  askRoles: [...USER_ROLES],
};

export const DEFAULT_REQUEST_MODULES: RequestModuleSettings = {
  media: { ...COMMON_DEFAULTS, handlerIds: [], allowDecline: false, mediaTypes: [...MEDIA_TYPES] },
  maintenance: {
    ...COMMON_DEFAULTS,
    assigneeIds: [],
    defaultAssigneeId: null,
    requireDueDate: true,
    allowDecline: false,
  },
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

const ids = z.array(z.string().cuid()).max(100).transform((list) => [...new Set(list)]);

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
});

export const mediaModuleSchema = commonSchema.extend(approveSchema.shape).extend({
  mediaTypes: z
    .array(z.enum(MEDIA_TYPES))
    .min(1, 'Offer at least one kind of media, or turn Media off.')
    .transform((list) => MEDIA_TYPES.filter((t) => list.includes(t))),
});

export const maintenanceModuleSchema = commonSchema
  .extend({
    assigneeIds: ids,
    defaultAssigneeId: z.string().cuid().nullable(),
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

/** What the Settings card sends: every module, every field. */
export const requestModulesSchema = z.object({
  media: mediaModuleSchema,
  maintenance: maintenanceModuleSchema,
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
  /** Approve workflow: marks these done (and declines, where allowed). */
  handles: boolean;
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

export function moduleViews(
  settings: RequestModuleSettings,
  viewer: { id: string; role: string },
  access: { create: boolean; approve: boolean },
  memberIds: readonly string[],
): RequestModuleView[] {
  const members = new Set(memberIds);
  return enabledModules(settings).map((id) => {
    const common = {
      id,
      workflow: REQUEST_MODULE_WORKFLOWS[id],
      label: moduleLabel(settings, id),
      note: settings[id].note,
      canAsk: access.create && roleMayAsk(settings[id], viewer.role),
    };
    if (id === 'media') {
      const m = settings.media;
      return {
        ...common,
        handles: handlesApproval(m, viewer.id, access.approve, members),
        allowDecline: m.allowDecline,
        mediaTypes: m.mediaTypes,
        assigneeIds: [],
        defaultAssigneeId: null,
        requireDueDate: false,
      };
    }
    const m = settings.maintenance;
    const choices = assigneeChoices(m, memberIds, viewer.id);
    return {
      ...common,
      handles: false,
      allowDecline: m.allowDecline,
      mediaTypes: [],
      assigneeIds: choices,
      defaultAssigneeId: m.defaultAssigneeId && choices.includes(m.defaultAssigneeId) ? m.defaultAssigneeId : null,
      requireDueDate: m.requireDueDate,
    };
  });
}
