import { ok, parseBody, withAuth } from '@/server/api/http';
import { markChangelogSeen } from '@/server/services/changelogService';
import { changelogSeenSchema } from '@/lib/validation/user';

// They closed "What's new": `id` is the newest entry it showed. It won't show
// again on the website or the app.
export const POST = withAuth(async (ctx) => {
  const { id } = await parseBody(ctx.req, changelogSeenSchema);
  await markChangelogSeen(ctx.user.id, id);
  return ok({ id });
});
