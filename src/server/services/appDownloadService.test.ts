import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appApkPath, getAppRelease, parseRelease } from './appDownloadService';

const meta = {
  versionName: '2026.10.07-abc1234',
  versionCode: 29_800_000,
  appId: 'com.example.ourhome',
  server: 'http://192.168.1.10:3000',
  builtAt: '2026-10-07T20:00:00Z',
  sizeBytes: 5,
  sha256: 'f'.repeat(64),
  firebase: true,
};

describe('parseRelease', () => {
  it('accepts the deploy script’s ourhome.json', () => {
    expect(parseRelease(meta)).toEqual(meta);
  });

  it('defaults server and firebase, and rejects missing or wrong-typed fields', () => {
    const bare: Partial<typeof meta> = { ...meta };
    delete bare.server;
    delete bare.firebase;
    expect(parseRelease(bare)).toMatchObject({ server: '', firebase: false });
    expect(parseRelease({ ...meta, versionCode: '1' })).toBeNull();
    expect(parseRelease({ ...meta, sha256: undefined })).toBeNull();
    expect(parseRelease(null)).toBeNull();
  });
});

describe('getAppRelease', () => {
  let dir: string | undefined;
  afterEach(() => {
    delete process.env.APP_DOWNLOAD_DIR;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('offers the app only when the APK matches its description', () => {
    expect(getAppRelease()).toBeNull(); // no APP_DOWNLOAD_DIR
    dir = mkdtempSync(path.join(tmpdir(), 'apk-'));
    process.env.APP_DOWNLOAD_DIR = dir;
    expect(getAppRelease()).toBeNull(); // empty folder

    writeFileSync(path.join(dir, 'ourhome.json'), JSON.stringify(meta));
    writeFileSync(path.join(dir, 'ourhome.apk'), '12345');
    expect(getAppRelease()?.versionName).toBe(meta.versionName);
    expect(appApkPath()).toBe(path.join(dir, 'ourhome.apk'));

    writeFileSync(path.join(dir, 'ourhome.apk'), '123'); // a half-copied APK
    expect(getAppRelease()).toBeNull();
    expect(appApkPath()).toBeNull();
  });
});
