import { NextResponse } from 'next/server';
import { requirePermission, withAuth } from '@/server/api/http';
import { exportHousehold } from '@/server/services/householdDataService';

// Settings → Export: the household's data as a JSON download (Head of House).
export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  const data = await exportHousehold(ctx.user.householdId!);
  const day = data.exportedAt.slice(0, 10);
  const slug = data.household.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'household';
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="ourhome-${slug}-${day}.json"`,
      'Cache-Control': 'no-store',
    },
  });
});
