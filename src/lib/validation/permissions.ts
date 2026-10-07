import { z } from 'zod';
import {
  ACCESS_ACTIONS,
  ACCESS_PAGES,
  EDITABLE_ROLES,
  type AccessAction,
  type AccessPage,
} from '@/lib/permissions';

const pageAccess = z.object(
  Object.fromEntries(ACCESS_ACTIONS.map((a) => [a, z.boolean()])) as Record<
    AccessAction,
    z.ZodBoolean
  >,
);

/** A complete grid: every page, every action. */
export const accessMatrixSchema = z.object(
  Object.fromEntries(ACCESS_PAGES.map((p) => [p, pageAccess])) as Record<
    AccessPage,
    typeof pageAccess
  >,
);

export const setRoleAccessSchema = z.object({
  role: z.enum(EDITABLE_ROLES),
  access: accessMatrixSchema,
});
export type SetRoleAccessInput = z.infer<typeof setRoleAccessSchema>;

export const setMemberAccessSchema = z.object({
  memberId: z.string().min(1),
  /** null resets the member to their role's default. */
  access: accessMatrixSchema.nullable(),
});
export type SetMemberAccessInput = z.infer<typeof setMemberAccessSchema>;
