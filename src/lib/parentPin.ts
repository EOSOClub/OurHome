// The parent PIN on a supervised child's phone (parental controls): what the
// phone tells their supervisors about it. Pure; parentPinService sends them.
//
// - wrong_pin: the PIN was entered wrong 5 times in a row, so the phone is
//   making them wait before the next try (anywhere it's asked for: a protected
//   screen, Profile, signing out, changing the PIN). At most once an hour.
// - opened: the PIN let someone into a protected screen ([PIN_SCREENS]), which
//   stays open until they leave it or the screen turns off. The settings
//   "Prevent uninstall" and "Keep Our Home running" stay on.
// - unlocked: the PIN was entered in Unlock Our Home (Profile, or Login while
//   offline), which turns Prevent uninstall off so OurHome can be uninstalled.

export const PIN_EVENT_KINDS = ['wrong_pin', 'opened', 'unlocked'] as const;
export type PinEventKind = (typeof PIN_EVENT_KINDS)[number];

/**
 * The screens the phone asks for the PIN on (its CloseGuard.Screen):
 * OurHome's App info (where Force stop is), its Device admin page (where
 * Prevent uninstall is turned off), Keep Our Home running in Accessibility,
 * and Private DNS while the web filter is on.
 */
export const PIN_SCREENS = ['app_info', 'device_admin', 'accessibility', 'private_dns'] as const;
export type PinScreen = (typeof PIN_SCREENS)[number];

const SCREEN_NAMES: Record<PinScreen, string> = {
  app_info: "OurHome's App info, where Force stop is",
  device_admin: "OurHome's Device admin page, where Prevent uninstall is turned off",
  accessibility: 'Keep Our Home running in Accessibility',
  private_dns: "Private DNS, the web filter's setting",
};

export function isPinEventKind(kind: string): kind is PinEventKind {
  return (PIN_EVENT_KINDS as readonly string[]).includes(kind);
}

/** The bell alert to a supervisor about the PIN on [name]'s phone ([screen]: for opened). */
export function pinEventText(kind: PinEventKind, name: string, screen?: string): { title: string; body: string } {
  if (kind === 'wrong_pin') {
    return {
      title: `Wrong parent PIN on ${name}'s phone`,
      body: `Someone entered the wrong parent PIN 5 times in a row on ${name}'s phone, so it's making them wait before trying again. You're told at most once an hour while it goes on.`,
    };
  }
  if (kind === 'opened') {
    const where = (PIN_SCREENS as readonly string[]).includes(screen ?? '')
      ? SCREEN_NAMES[screen as PinScreen]
      : 'a protected screen';
    return {
      title: `Your PIN was used on ${name}'s phone`,
      body: `The parent PIN was entered on ${name}'s phone to open ${where}. It stays open until they leave it or the screen turns off, then it's protected again.`,
    };
  }
  return {
    title: `Your PIN unlocked OurHome on ${name}'s phone`,
    body: `The parent PIN was entered in OurHome on ${name}'s phone, which turned Prevent uninstall off, so OurHome can be uninstalled there until it's set up again.`,
  };
}
