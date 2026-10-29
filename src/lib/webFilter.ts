// Web filtering (parental controls): a supervising adult picks a family filter
// for a child's phone, and the phone uses it through Android's Private DNS
// (Settings, Network & internet, Private DNS), so websites are filtered in
// every browser and app there. OurHome can't switch Private DNS on by itself:
// Set up this phone shows the filter's hostname to enter, the phone reports
// what Private DNS is set to, and its supervisors are told when it no longer
// matches. Pure, shared by the server and the client.

/** The filters a supervising adult can choose (User.webFilter). */
export const WEB_FILTERS = ['family', 'adult'] as const;
export type WebFilter = (typeof WEB_FILTERS)[number];

/**
 * What each filter is, for the chooser and Set up this phone. hostname: what
 * goes into Android's Private DNS ("Private DNS provider hostname").
 * - family: CleanBrowsing's Family Filter. Blocks adult sites, and the proxy
 *   and VPN sites used to get around a filter, and keeps Google, Bing, and
 *   YouTube on safe search.
 * - adult: Cloudflare's 1.1.1.1 for Families. Blocks adult sites and malware.
 */
export const WEB_FILTER_INFO: Record<WebFilter, { label: string; hostname: string; blurb: string }> = {
  family: {
    label: 'Family filter',
    hostname: 'family-filter-dns.cleanbrowsing.org',
    blurb: 'Blocks adult sites and the proxy and VPN sites used to get around it, and keeps Google, Bing and YouTube on safe search. From CleanBrowsing.',
  },
  adult: {
    label: 'Adult sites only',
    hostname: 'family.cloudflare-dns.com',
    blurb: 'Blocks adult sites and harmful ones (malware). From Cloudflare.',
  },
};

/** A stored value as a filter; anything else (null, an old or unknown value) is off. */
export function webFilterOf(stored: string | null | undefined): WebFilter | null {
  return (WEB_FILTERS as readonly string[]).includes(stored ?? '') ? (stored as WebFilter) : null;
}

/** A hostname as compared: lower case, without a trailing dot. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Whether the phone uses [filter]: its Private DNS ([privateDns], as it last
 * said: a hostname, or "off" while it isn't set to one) is the filter's hostname. null when
 * the phone never said (an app from before web filtering).
 */
export function webFilterOn(filter: WebFilter, privateDns: string | null | undefined): boolean | null {
  if (privateDns == null) return null;
  return normalizeHost(privateDns) === WEB_FILTER_INFO[filter].hostname;
}
