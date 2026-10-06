// Deployment-specific settings read from the environment (the root .env). Kept in
// one place so the code carries no household- or domain-specific defaults.

/** Name shown in emails and auth messages. */
export const APP_NAME = process.env.APP_NAME?.trim() || 'Our Home';
