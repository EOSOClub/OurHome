// Shared by the Leaflet maps (Settings → Map places pin picker, the Map page).
// OpenStreetMap tiles: free, no API key. Client only (reads the document).

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** A theme color by CSS variable (SVG attributes can't read CSS variables). */
export function themeColor(variable: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return value || fallback;
}

/** The theme's primary color. */
export function primaryColor(): string {
  return themeColor('--primary', 'hsl(221 83% 53%)');
}
