import { z } from 'zod';

// A record id. Prisma's `@default(cuid())` makes CUID v1 ids, so that is the
// format to check. zod marks z.cuid() deprecated because v1 ids embed their
// creation time, which is about making new ids, not checking ones that exist;
// z.cuid2() would accept any run of lowercase letters and digits. If ids ever
// move to cuid2, this is the one place to change.
// noinspection JSDeprecatedSymbols
export const recordId = z.cuid();
