import { PrismaClient } from '@prisma/client';

// ONE-OFF (2026-10-11): rename the stored "member" role to "adult".
// Delete this file once every server it is meant for has been migrated.
//
//   npx tsx scripts/migrate-member-to-adult.ts --uri "<mongodb uri>"           # dry run
//   npx tsx scripts/migrate-member-to-adult.ts --uri "<mongodb uri>" --apply   # write
//
// Run it after the code that knows "adult" is deployed. It changes:
// - User.role "member" -> "adult"
// - the "member" key in Household.roleAccess (the head's edits to each role's
//   page-access grid) -> "adult", so those edits keep applying.
// Safe to run twice: the second run finds nothing to change.
//
// The database is only ever the one passed with --uri. This script does not
// read .env, settings.yml or the secrets file, so it cannot pick up the real
// server by accident. The uri is never printed, only its host.

const LEGACY = 'member';
const ROLE = 'adult';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The roleAccess JSON with its "member" key renamed, or null when there is nothing to change. */
export function renameGridKey(raw: string | null): string | null {
  if (!raw) return null;
  let grid: unknown;
  try {
    grid = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!grid || typeof grid !== 'object' || Array.isArray(grid)) return null;
  const obj = grid as Record<string, unknown>;
  if (!(LEGACY in obj)) return null;
  const { [LEGACY]: legacy, ...rest } = obj;
  return JSON.stringify({ ...rest, [ROLE]: rest[ROLE] ?? legacy });
}

async function main() {
  const uri = arg('--uri');
  const apply = process.argv.includes('--apply');
  if (!uri) {
    console.log('Missing --uri "<mongodb uri>". Nothing done.');
    process.exit(1);
  }
  let host = '(unparsed)';
  try {
    host = new URL(uri).host;
  } catch {
    // Multi-host replica set uris don't parse as a URL; the host stays hidden.
  }
  console.log(`[migrate] ${apply ? 'APPLY' : 'DRY RUN'} against ${host}`);

  const prisma = new PrismaClient({ datasourceUrl: uri });
  try {
    const before = await prisma.user.count({ where: { role: LEGACY } });
    const already = await prisma.user.count({ where: { role: ROLE } });
    console.log(`[migrate] users: ${before} with "${LEGACY}", ${already} already "${ROLE}"`);

    const households = await prisma.household.findMany({ select: { id: true, name: true, roleAccess: true } });
    const grids = households
      .map((h) => ({ ...h, next: renameGridKey(h.roleAccess) }))
      .filter((h) => h.next !== null);
    console.log(`[migrate] households: ${households.length} total, ${grids.length} with a "${LEGACY}" grid key`);
    for (const h of grids) console.log(`[migrate]   grid to rename: ${h.name} (${h.id})`);

    if (!apply) {
      console.log('[migrate] dry run, nothing written. Add --apply to write.');
      return;
    }

    const users = await prisma.user.updateMany({ where: { role: LEGACY }, data: { role: ROLE } });
    console.log(`[migrate] users renamed: ${users.count}`);
    for (const h of grids) {
      await prisma.household.update({ where: { id: h.id }, data: { roleAccess: h.next } });
      console.log(`[migrate] grid renamed: ${h.name}`);
    }

    const left = await prisma.user.count({ where: { role: LEGACY } });
    const now = await prisma.user.count({ where: { role: ROLE } });
    console.log(`[migrate] done: ${left} left with "${LEGACY}", ${now} now "${ROLE}"`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
