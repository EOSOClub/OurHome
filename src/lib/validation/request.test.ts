import { describe, expect, it } from 'vitest';
import { acceptRequestSchema, createRequestSchema } from '@/lib/validation/request';

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
