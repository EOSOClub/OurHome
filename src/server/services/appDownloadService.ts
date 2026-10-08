import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The Android app the deploy builds (docker.example/android) lands in
// APP_DOWNLOAD_DIR (android/out, mounted read-only): ourhome.apk plus
// ourhome.json describing it. Read on each request, so a new build shows up
// without restarting the app. No directory, no file, or a broken description
// = no app on offer, and the page shows nothing.

export interface AppRelease {
  versionName: string;
  versionCode: number;
  appId: string;
  /** The server address built in; empty = the app asks at sign-in. */
  server: string;
  builtAt: string;
  sizeBytes: number;
  sha256: string;
  /** Built with google-services.json, i.e. with instant alerts. */
  firebase: boolean;
}

export const APK_FILE = 'ourhome.apk';
const META_FILE = 'ourhome.json';

/** ourhome.json's content as an AppRelease, or null when it's not usable. */
export function parseRelease(raw: unknown): AppRelease | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const versionName = str(r.versionName);
  const versionCode = num(r.versionCode);
  const appId = str(r.appId);
  const builtAt = str(r.builtAt);
  const sizeBytes = num(r.sizeBytes);
  const sha256 = str(r.sha256);
  if (!versionName || versionCode === null || !appId || !builtAt || sizeBytes === null || !sha256) return null;
  return { versionName, versionCode, appId, server: str(r.server) ?? '', builtAt, sizeBytes, sha256, firebase: r.firebase === true };
}

export function appDownloadDir(): string | null {
  return process.env.APP_DOWNLOAD_DIR?.trim() || null;
}

/** The app on offer, or null. */
export function getAppRelease(): AppRelease | null {
  const dir = appDownloadDir();
  if (!dir) return null;
  try {
    const apk = path.join(dir, APK_FILE);
    const meta = path.join(dir, META_FILE);
    if (!existsSync(apk) || !existsSync(meta)) return null;
    const release = parseRelease(JSON.parse(readFileSync(meta, 'utf8')));
    // The metadata must describe the APK that's actually there.
    if (!release || statSync(apk).size !== release.sizeBytes) return null;
    return release;
  } catch {
    return null;
  }
}

/** Where the APK is, when one is on offer. */
export function appApkPath(): string | null {
  const dir = appDownloadDir();
  return dir && getAppRelease() ? path.join(dir, APK_FILE) : null;
}
