import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  announceRequestAnswer,
  requestNoticeText,
  type AnsweredRequest,
} from '@/server/services/requestNoticeService';

const base: AnsweredRequest = {
  id: 'r1',
  category: 'permission',
  title: 'Sleepover at Sam’s',
  year: null,
  issue: false,
  quantity: null,
  requesterId: 'kid',
  dueAt: null,
  addedToList: null,
  reply: null,
};

function fakeDb() {
  const create = vi.fn();
  const deleteMany = vi.fn();
  const updateMany = vi.fn();
  const db = { notification: { create, deleteMany, updateMany } } as unknown as Prisma.TransactionClient;
  return { db, create, deleteMany, updateMany };
}

describe('requestNoticeText', () => {
  it('says yes to a permission', () => {
    expect(requestNoticeText(base, 'approved', 'Alex')).toEqual({
      title: 'Approved: Sleepover at Sam’s',
      body: 'Alex said yes.',
    });
  });

  it('names the shopping list an approved purchase went on, with the quantity', () => {
    const r = { ...base, category: 'purchase', title: 'AA batteries', quantity: 2, addedToList: 'Groceries' };
    expect(requestNoticeText(r, 'approved', 'Alex')).toEqual({
      title: 'Approved: 2 × AA batteries',
      body: 'Alex said yes and added it to Groceries.',
    });
  });

  it('gives the reason for a no, when there is one', () => {
    expect(requestNoticeText({ ...base, reply: ' School night ' }, 'declined', 'Alex').body).toBe(
      'Alex said no: School night',
    );
    expect(requestNoticeText(base, 'declined', 'Alex')).toEqual({
      title: 'Declined: Sleepover at Sam’s',
      body: 'Alex said no.',
    });
  });

  it('reads media as added, or fixed for a problem report', () => {
    const media = { ...base, category: 'media', title: 'Dune', year: 2021 };
    expect(requestNoticeText(media, 'approved', 'Alex')).toEqual({ title: 'Added: Dune (2021)', body: 'Alex added it.' });
    expect(requestNoticeText({ ...media, issue: true }, 'approved', 'Alex')).toEqual({
      title: 'Fixed: Dune (2021)',
      body: 'Alex marked it fixed.',
    });
  });

  it('gives maintenance its done-by day in the household zone, and done', () => {
    const job = { ...base, category: 'maintenance', title: 'Fix the faucet' };
    expect(
      requestNoticeText({ ...job, dueAt: new Date('2026-10-30T03:00:00Z') }, 'accepted', 'Alex', 'America/Chicago'),
    ).toEqual({ title: 'Accepted: Fix the faucet', body: 'Alex will have it done by Thu, Oct 29.' });
    expect(requestNoticeText(job, 'accepted', 'Alex').body).toBe('Alex said they’ll do it.');
    expect(requestNoticeText(job, 'done', 'Alex')).toEqual({ title: 'Done: Fix the faucet', body: 'Alex marked it done.' });
  });
});

describe('announceRequestAnswer', () => {
  it('replaces the request’s notice with one addressed to the requester', async () => {
    const { db, create, deleteMany } = fakeDb();
    expect(await announceRequestAnswer(db, 'h', base, 'approved', { id: 'mom', name: 'Alex' })).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({ where: { householdId: 'h', type: 'request_update', subjectId: 'r1' } });
    expect(create.mock.calls[0][0].data).toMatchObject({
      householdId: 'h',
      userId: 'kid',
      type: 'request_update',
      title: 'Approved: Sleepover at Sam’s',
      subjectType: 'request',
      subjectId: 'r1',
      dedupeKey: 'request_update:request:r1',
      readAt: null,
    });
  });

  it('tells nobody about their own doing', async () => {
    const { db, create, deleteMany } = fakeDb();
    expect(await announceRequestAnswer(db, 'h', base, 'approved', { id: 'kid', name: 'Riley' })).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('quiet only rewrites a notice that is there, so nothing alerts again', async () => {
    const { db, create, deleteMany, updateMany } = fakeDb();
    const job = { ...base, category: 'maintenance', title: 'Fix the faucet' };
    expect(await announceRequestAnswer(db, 'h', job, 'accepted', { id: 'mom', name: 'Alex' }, { quiet: true })).toBe(
      false,
    );
    expect(create).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { householdId: 'h', type: 'request_update', subjectId: 'r1' },
      data: { title: 'Accepted: Fix the faucet', body: 'Alex said they’ll do it.' },
    });
  });
});
