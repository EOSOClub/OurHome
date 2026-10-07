import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { loadSettings } from './src/server/settings';

// The Prisma CLI reads DATABASE_URL from the environment, so fill it from
// settings.yml first: server values in the container (NODE_ENV=production),
// the `dev:` values everywhere else.
loadSettings();

// MongoDB has no SQL migrations — the schema is applied with `prisma db push`
// (see the db:* scripts in package.json). This config also points Prisma at the
// schema folder (models.prisma + datasource.prisma).
export default defineConfig({
  schema: path.join('prisma', 'schema'),
});
