'use client';

import { createContext, useContext } from 'react';
import { FEATURES, featureForPath, type Feature } from '@/lib/features';

// The features the server admin left on for this household, from the app
// layout, so menus and nav links can hide the rest. The server enforces it
// anyway (API 403, pages redirect); this only keeps dead links out of sight.

const HouseholdFeaturesContext = createContext<readonly Feature[]>(FEATURES);

export function HouseholdFeaturesProvider({
  features,
  children,
}: {
  features: Feature[];
  children: React.ReactNode;
}) {
  return <HouseholdFeaturesContext.Provider value={features}>{children}</HouseholdFeaturesContext.Provider>;
}

export function useHouseholdFeatures(): readonly Feature[] {
  return useContext(HouseholdFeaturesContext);
}

/** Whether a link to `href` leads somewhere this household has on. */
export function useHrefEnabled(): (href: string) => boolean {
  const features = useHouseholdFeatures();
  return (href) => {
    const feature = featureForPath(href);
    return !feature || features.includes(feature);
  };
}
