import { describe, expect, it } from 'vitest';
import { CHANGELOG, latestChangelogId, unseenChangelog, type ChangelogEntry } from '@/lib/changelog';

const entry = (id: string, date = id.slice(0, 10)): ChangelogEntry => ({ id, date, title: id, changes: ['x'] });
// Newest first, as in CHANGELOG.
const LOG = [entry('2026-11-02b'), entry('2026-11-02'), entry('2026-10-20'), entry('2026-10-01')];

describe('unseenChangelog', () => {
  it('shows the entries newer than the last one they closed, newest first', () => {
    expect(unseenChangelog('2026-10-20', new Date('2026-01-01'), LOG).map((e) => e.id)).toEqual([
      '2026-11-02b',
      '2026-11-02',
    ]);
  });

  it('shows nothing once the newest is closed', () => {
    expect(unseenChangelog('2026-11-02b', new Date('2026-01-01'), LOG)).toEqual([]);
  });

  it('a second release the same day still counts as newer', () => {
    expect(unseenChangelog('2026-11-02', new Date('2026-01-01'), LOG).map((e) => e.id)).toEqual(['2026-11-02b']);
  });

  it('never closed one: only what came out after they joined', () => {
    expect(unseenChangelog(null, new Date('2026-10-25T09:00:00Z'), LOG).map((e) => e.id)).toEqual([
      '2026-11-02b',
      '2026-11-02',
    ]);
    // Joined the day of the newest release: nothing to catch up on.
    expect(unseenChangelog(null, new Date('2026-11-02T20:00:00Z'), LOG)).toEqual([]);
  });

  it('shows at most five', () => {
    const many = Array.from({ length: 8 }, (_, i) => entry(`2026-10-${String(20 - i).padStart(2, '0')}`));
    expect(unseenChangelog('2026-01-01', new Date('2026-01-01'), many)).toHaveLength(5);
  });
});

describe('CHANGELOG', () => {
  it('is newest first with unique ids that sort as text', () => {
    const ids = CHANGELOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort().reverse()).toEqual(ids);
    expect(latestChangelogId()).toBe(ids[0]);
  });

  it('every entry has a real date, a title and changes, with plain hyphens only', () => {
    for (const e of CHANGELOG) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.id.startsWith(e.date)).toBe(true);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.changes.length).toBeGreaterThan(0);
      expect(JSON.stringify(e)).not.toMatch(/[‒-―−]/);
    }
  });
});
