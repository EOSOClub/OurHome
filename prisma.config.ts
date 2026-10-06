import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

// MongoDB has no SQL migrations — the schema is applied with `prisma db push`
// (see the db:* scripts in package.json). This config just points Prisma at the
// schema folder (models.prisma + datasource.prisma).
export default defineConfig({
  schema: path.join('prisma', 'schema'),
});
