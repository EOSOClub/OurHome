import { describe, expect, it } from 'vitest';
import {
  COMPLETE_BODY_MAX_BYTES,
  PHOTO_BASE64_MAX,
  completeTaskSchema,
  createTaskSchema,
  decideSubmissionSchema,
  listTasksQuerySchema,
  updateTaskSchema,
} from '@/lib/validation/task';
import { NOTIFICATION_TYPES, NOTIFICATION_TYPE_LABELS, TASK_STATUSES, TASK_STATUS_LABELS, WRITABLE_TASK_STATUSES } from '@/lib/enums';
import { PHOTO_MAX_BYTES } from '@/server/security/jpeg';

const ID = 'cmabcdefghijklmnopqrstuvw';

describe('task status', () => {
  it('can never be set to waiting for an OK by an edit', () => {
    expect(updateTaskSchema.safeParse({ taskId: ID, status: 'awaiting_review' }).success).toBe(false);
    for (const status of WRITABLE_TASK_STATUSES) {
      expect(updateTaskSchema.safeParse({ taskId: ID, status }).success).toBe(true);
    }
  });

  it('is not part of a new task at all', () => {
    expect(createTaskSchema.parse({ title: 'Dishes', status: 'awaiting_review' })).not.toHaveProperty('status');
  });

  it('can still be read and filtered on', () => {
    expect(TASK_STATUSES).toContain('awaiting_review');
    expect(listTasksQuerySchema.parse({ status: 'awaiting_review' }).status).toBe('awaiting_review');
    expect(TASK_STATUS_LABELS.awaiting_review).toBe('Waiting for an OK');
  });

  it('writable is every status but awaiting_review', () => {
    expect([...WRITABLE_TASK_STATUSES]).toEqual(TASK_STATUSES.filter((s) => s !== 'awaiting_review'));
  });
});

describe('completing and sending for a check', () => {
  it('accepts what older apps send, and the new fields', () => {
    expect(completeTaskSchema.parse({ taskId: ID })).toEqual({ taskId: ID });
    expect(completeTaskSchema.parse({ taskId: ID, checks: 1, forCheck: true, note: ' Done ', photo: 'AQID' })).toEqual({
      taskId: ID,
      checks: 1,
      forCheck: true,
      note: 'Done',
      photo: 'AQID',
    });
  });

  it('refuses a photo sent without a check (422 on the photo field)', () => {
    const result = completeTaskSchema.safeParse({ taskId: ID, checks: 1, photo: 'AQID' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['photo']);
  });

  it('a full-size photo as base64, with every other field, fits under the route’s cap', () => {
    // The largest photo the server keeps, as base64.
    const photo = Buffer.alloc(PHOTO_MAX_BYTES, 0xab).toString('base64');
    expect(photo.length).toBe(2_097_152);
    expect(photo.length).toBeLessThanOrEqual(PHOTO_BASE64_MAX);
    const body = JSON.stringify({
      taskId: ID,
      checks: 1,
      forCheck: true,
      note: 'x'.repeat(500),
      photo: `data:image/jpeg;base64,${photo}`,
    });
    expect(Buffer.byteLength(body)).toBeLessThan(COMPLETE_BODY_MAX_BYTES);
    expect(COMPLETE_BODY_MAX_BYTES).toBe(2_411_724);
    expect(completeTaskSchema.safeParse(JSON.parse(body)).success).toBe(true);
    // One more photo's worth is not accepted.
    expect(completeTaskSchema.safeParse({ taskId: ID, forCheck: true, photo: 'A'.repeat(PHOTO_BASE64_MAX + 1) }).success).toBe(false);
  });
});

describe('deciding a check', () => {
  it('a send back says what needs fixing (1 to 300 characters)', () => {
    expect(decideSubmissionSchema.safeParse({ submissionId: ID, decision: 'send_back' }).success).toBe(false);
    expect(decideSubmissionSchema.safeParse({ submissionId: ID, decision: 'send_back', reviewNote: '  ' }).success).toBe(false);
    expect(decideSubmissionSchema.safeParse({ submissionId: ID, decision: 'send_back', reviewNote: 'x'.repeat(301) }).success).toBe(false);
    expect(decideSubmissionSchema.safeParse({ submissionId: ID, decision: 'send_back', reviewNote: 'Again', redoStepIds: [ID] }).success).toBe(true);
    expect(decideSubmissionSchema.safeParse({ submissionId: ID, decision: 'approve' }).success).toBe(true);
    expect(decideSubmissionSchema.safeParse({ submissionId: ID, decision: 'maybe' }).success).toBe(false);
  });
});

describe('Ask for a photo', () => {
  it('is part of a task’s create and update', () => {
    expect(createTaskSchema.parse({ title: 'Room', photoProof: true }).photoProof).toBe(true);
    expect(updateTaskSchema.parse({ taskId: ID, photoProof: false }).photoProof).toBe(false);
  });
});

describe('check notifications', () => {
  it('are registered with their labels', () => {
    expect(NOTIFICATION_TYPES).toContain('task_review');
    expect(NOTIFICATION_TYPES).toContain('task_reviewed');
    expect(NOTIFICATION_TYPE_LABELS.task_review).toBe('To check');
    expect(NOTIFICATION_TYPE_LABELS.task_reviewed).toBe('Checked');
  });
});
