import { getAccess, ok, withAuth } from '@/server/api/http';
import type { MyAccessDTO } from '@/lib/types';

// The signed-in user's own page access, so clients (the Android app) can hide
// controls without duplicating the resolution rules. "Own" = createdById.
export const GET = withAuth(async (ctx) => {
  const dto: MyAccessDTO = {
    userId: ctx.user.id,
    role: ctx.user.role,
    access: await getAccess(ctx),
  };
  return ok(dto);
});
