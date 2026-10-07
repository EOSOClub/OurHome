// Deployment-specific settings read from the environment (filled from the root
// settings.yml at startup, see src/server/settings.ts). Kept in
// one place so the code carries no household- or domain-specific defaults.

/** Name shown in emails and auth messages. */
export const APP_NAME = process.env.APP_NAME?.trim() || 'Our Home';
