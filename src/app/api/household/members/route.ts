import { ok, withAuth } from '@/server/api/http';
import { listHouseholdProfiles } from '@/server/services/profileService';

// Lightweight member list for pickers — e.g. choosing who should handle a
// maintenance request — plus each member's role and about-me fields (the
// household directory on Profile). Any household member may read it; the full
// management view (emails etc.) stays behind members:manage at /api/members.
export const GET = withAuth(async ({ user }) => {
  return ok(await listHouseholdProfiles(user.householdId!));
});
