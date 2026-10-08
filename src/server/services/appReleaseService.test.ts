import { describe, expect, it } from 'vitest';
import { appReleaseNotification } from './appReleaseService';

describe('appReleaseNotification', () => {
  const release = {
    versionName: '2026.10.08-abc1234',
    versionCode: 29_860_000,
    appId: 'com.example.ourhome',
    server: '',
    builtAt: '2026-10-08T12:00:00Z',
    sizeBytes: 1,
    sha256: 'f'.repeat(64),
    firebase: false,
  };

  it('is a household-wide system notice, once per version, linking to Profile', () => {
    const n = appReleaseNotification(release);
    // 'system' is never touched by the reminder generator's cleanup.
    expect(n.type).toBe('system');
    expect(n.dedupeKey).toBe('app_release:29860000');
    expect(n.subjectType).toBe('app_release');
    expect(n.title).toContain(release.versionName);
    expect(n.body).toContain('Profile');
  });
});
