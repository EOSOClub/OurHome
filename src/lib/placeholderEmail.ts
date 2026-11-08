// Stand-in email addresses for members added without one (usually children).
//
// Better Auth needs every user to have a unique email, so a member added
// with the email left blank gets `<username>@household.local`. That address
// belongs to nobody: `.local` is reserved for the home network, so nothing
// sent there is ever read, and a send attempt only fills the mail log with
// failures. Anything that emails a member checks isPlaceholderEmail first.

const PLACEHOLDER_DOMAIN = 'household.local';

/** The stand-in address for a member added without an email. */
export function placeholderEmailFor(username: string): string {
  return `${username}@${PLACEHOLDER_DOMAIN}`.toLowerCase();
}

/** True for a stand-in address (see above): never send mail to it. */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith(`@${PLACEHOLDER_DOMAIN}`);
}
