import { ok, parseBody, withAuth } from '@/server/api/http';
import { unregisterDevice } from '@/server/services/pushService';
import { pushDeviceSchema } from '@/lib/validation/push';

// Called by the app just before it signs out, so a shared phone stops getting
// the previous user's alerts.
export const POST = withAuth(async ({ user, req }) => {
  const { token } = await parseBody(req, pushDeviceSchema);
  await unregisterDevice(user.id, token);
  return ok({ removed: true });
});
