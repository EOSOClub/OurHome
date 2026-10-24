import { describe, expect, it } from 'vitest';
import {
  acceptRequestSchema,
  completeRequestSchema,
  createRequestSchema,
  declineRequestSchema,
} from '@/lib/validation/request';

const movie = { category: 'media', mediaType: 'movie', title: 'Dune', year: 2021 };

describe('createRequestSchema', () => {
  it('accepts a movie with a name and year', () => {
    expect(createRequestSchema.safeParse(movie).success).toBe(true);
  });

  it('accepts a TV show with or without a season', () => {
    const tv = { category: 'media', mediaType: 'tv', title: 'Severance', year: 2022 };
    expect(createRequestSchema.safeParse(tv).success).toBe(true);
    expect(createRequestSchema.safeParse({ ...tv, year: 2025, season: 2 }).success).toBe(true);
  });

  it('requires a name and a year', () => {
    expect(createRequestSchema.safeParse({ ...movie, title: '  ' }).success).toBe(false);
    const noYear = { category: 'media', mediaType: 'movie', title: 'Dune' };
    expect(createRequestSchema.safeParse(noYear).success).toBe(false);
  });

  it('rejects a season on a movie', () => {
    expect(createRequestSchema.safeParse({ ...movie, season: 1 }).success).toBe(false);
  });

  it('rejects unknown categories and media types', () => {
    expect(createRequestSchema.safeParse({ ...movie, category: 'food' }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...movie, mediaType: 'book' }).success).toBe(false);
  });

  const tvProblem = {
    category: 'media',
    mediaType: 'tv',
    title: 'Severance',
    year: 2022,
    issue: true,
    details: 'No sound after 20 minutes',
  };

  it('accepts a problem with a whole show, a season, or one episode', () => {
    expect(createRequestSchema.safeParse(tvProblem).success).toBe(true);
    expect(createRequestSchema.safeParse({ ...tvProblem, season: 2 }).success).toBe(true);
    expect(createRequestSchema.safeParse({ ...tvProblem, season: 2, episode: 3 }).success).toBe(true);
    const movieProblem = { ...movie, issue: true, details: 'Subtitles out of sync' };
    expect(createRequestSchema.safeParse(movieProblem).success).toBe(true);
  });

  it('requires a problem to say what is wrong', () => {
    expect(createRequestSchema.safeParse({ ...tvProblem, details: undefined }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...tvProblem, details: '   ' }).success).toBe(false);
  });

  it('only takes an episode with a season, on a TV problem', () => {
    expect(createRequestSchema.safeParse({ ...tvProblem, episode: 3 }).success).toBe(false);
    const tv = { category: 'media', mediaType: 'tv', title: 'Severance', year: 2025, season: 2 };
    expect(createRequestSchema.safeParse({ ...tv, episode: 3 }).success).toBe(false);
  });

  it('treats a request without the problem flag as a request to add it', () => {
    const parsed = createRequestSchema.parse(movie);
    expect(parsed.category === 'media' && parsed.issue).toBeFalsy();
  });

  const maintenance = {
    category: 'maintenance',
    title: 'Fix the leaky faucet',
    assigneeId: 'cmabcdefghijklmnopqrstuvw',
  };

  it('accepts a maintenance request with a title and an assignee', () => {
    expect(createRequestSchema.safeParse(maintenance).success).toBe(true);
    expect(
      createRequestSchema.safeParse({ ...maintenance, details: 'Kitchen sink, drips overnight' }).success,
    ).toBe(true);
  });

  it('requires an assignee and a title for maintenance', () => {
    const noAssignee = { category: 'maintenance', title: 'Fix the leaky faucet' };
    expect(createRequestSchema.safeParse(noAssignee).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...maintenance, title: '' }).success).toBe(false);
  });

  it('accepts a purchase with just a name, or with a link, price, quantity and why', () => {
    expect(createRequestSchema.safeParse({ category: 'purchase', title: 'LEGO Space set' }).success).toBe(true);
    const full = {
      category: 'purchase',
      title: 'LEGO Space set',
      url: 'https://example.com/lego',
      imageUrl: 'https://example.com/lego.jpg',
      price: 49.99,
      quantity: 2,
      details: 'For the science fair',
    };
    expect(createRequestSchema.safeParse(full).success).toBe(true);
    expect(createRequestSchema.safeParse({ ...full, url: 'not a link' }).success).toBe(false);
    // Web links only: these would be stored and opened from the page or the app.
    expect(createRequestSchema.safeParse({ ...full, url: 'javascript:alert(1)' }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...full, imageUrl: 'data:text/html,hi' }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...full, price: -1 }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...full, quantity: 0 }).success).toBe(false);
  });

  describe('permission', () => {
    const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const sleepover = { category: 'permission', title: 'Sleepover at Sam’s' };

    it('needs only what it’s for; from and until are optional', () => {
      expect(createRequestSchema.safeParse(sleepover).success).toBe(true);
      expect(createRequestSchema.safeParse({ ...sleepover, startsAt: inHours(5) }).success).toBe(true);
      expect(createRequestSchema.safeParse({ ...sleepover, startsAt: inHours(5), endsAt: inHours(20) }).success).toBe(true);
      expect(createRequestSchema.safeParse({ ...sleepover, title: ' ' }).success).toBe(false);
    });

    it('until needs a from before it', () => {
      expect(createRequestSchema.safeParse({ ...sleepover, endsAt: inHours(20) }).success).toBe(false);
      expect(createRequestSchema.safeParse({ ...sleepover, startsAt: inHours(20), endsAt: inHours(5) }).success).toBe(false);
      expect(createRequestSchema.safeParse({ ...sleepover, startsAt: inHours(5), endsAt: inHours(5) }).success).toBe(false);
    });

    it('can’t start in the past', () => {
      expect(createRequestSchema.safeParse({ ...sleepover, startsAt: inHours(-48) }).success).toBe(false);
    });
  });
});

describe('completeRequestSchema', () => {
  const id = 'cmabcdefghijklmnopqrstuvw';

  it('takes an optional shopping list', () => {
    expect(completeRequestSchema.parse({ id }).listId).toBeUndefined();
    expect(completeRequestSchema.parse({ id, listId: null }).listId).toBeNull();
    expect(completeRequestSchema.safeParse({ id, listId: 'cmabcdefghijklmnopqrstuvx' }).success).toBe(true);
    expect(completeRequestSchema.safeParse({ id, listId: 'groceries' }).success).toBe(false);
  });
});

describe('acceptRequestSchema', () => {
  const id = 'cmabcdefghijklmnopqrstuvw';

  it('accepts today or a later done-by date', () => {
    expect(acceptRequestSchema.safeParse({ id, dueAt: new Date().toISOString() }).success).toBe(true);
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(acceptRequestSchema.safeParse({ id, dueAt: nextWeek }).success).toBe(true);
  });

  it('rejects a done-by date in the past', () => {
    const lastWeek = new Date(Date.now() - 7 * 86_400_000).toISOString();
    expect(acceptRequestSchema.safeParse({ id, dueAt: lastWeek }).success).toBe(false);
  });
});

describe('declineRequestSchema', () => {
  const id = 'cmabcdefghijklmnopqrstuvw';

  it('takes an optional reason; blank is none', () => {
    expect(declineRequestSchema.parse({ id }).reply).toBeNull();
    expect(declineRequestSchema.parse({ id, reply: '   ' }).reply).toBeNull();
    expect(declineRequestSchema.parse({ id, reply: ' Already on Plex ' }).reply).toBe('Already on Plex');
  });

  it('rejects a reason over 500 characters', () => {
    expect(declineRequestSchema.safeParse({ id, reply: 'x'.repeat(501) }).success).toBe(false);
  });
});
