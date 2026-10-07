import { ok, parseBody, withAuth } from '@/server/api/http';
import { registerDevice } from '@/server/services/pushService';
import { pushDeviceSchema } from '@/lib/validation/push';

// The Android app registers its FCM token after sign-in (and whenever Firebase
// rotates it). Any signed-in member may register their own phone.
export const POST = withAuth(async ({ user, req }) => {
  const { token } = await parseBody(req, pushDeviceSchema);
  return ok(await registerDevice(user.householdId!, user.id, token));
});
