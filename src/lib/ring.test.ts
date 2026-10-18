import { describe, expect, it } from 'vitest';
import { ringActive, ringOutcome, ringPhase, stoppedAfterSec, type RingState } from './ring';

const sent: RingState = { sentAt: 0, ringingAt: null, endedAt: null, ended: null };

describe('ringPhase', () => {
  it('waits for the phone while the push may still arrive, then gives up', () => {
    expect(ringPhase(sent, 10_000)).toBe('sending');
    expect(ringPhase(sent, 74_000)).toBe('sending');
    expect(ringPhase(sent, 75_000)).toBe('no_answer');
  });

  it('rings once the phone says so, until it has had time to say how it ended', () => {
    const ringing = { ...sent, ringingAt: 2_000 };
    expect(ringPhase(ringing, 20_000)).toBe('ringing');
    expect(ringPhase(ringing, 46_000)).toBe('ringing');
    expect(ringPhase(ringing, 47_000)).toBe('rang');
  });

  it('takes the phone’s word on how it ended', () => {
    expect(ringPhase({ ...sent, ringingAt: 2_000, endedAt: 9_000, ended: 'stopped' }, 9_000)).toBe('stopped');
    expect(ringPhase({ ...sent, ringingAt: 2_000, endedAt: 32_000, ended: 'rang_out' }, 600_000)).toBe('rang_out');
    // Its "ringing" got lost on the way: the ending still counts.
    expect(ringPhase({ ...sent, endedAt: 9_000, ended: 'stopped' }, 9_000)).toBe('stopped');
  });

  it('is only going while sending or ringing', () => {
    expect(['sending', 'ringing', 'stopped', 'rang_out', 'rang', 'no_answer'].filter((p) => ringActive(p as never))).toEqual([
      'sending',
      'ringing',
    ]);
  });
});

describe('stoppedAfterSec', () => {
  it('counts from when it started ringing, whole seconds from 1 to 30', () => {
    expect(stoppedAfterSec({ ...sent, ringingAt: 2_000, endedAt: 9_400, ended: 'stopped' })).toBe(7);
    expect(stoppedAfterSec({ ...sent, ringingAt: 2_000, endedAt: 2_100, ended: 'stopped' })).toBe(1);
    expect(stoppedAfterSec({ ...sent, ringingAt: 2_000, endedAt: 40_000, ended: 'stopped' })).toBe(30);
  });

  it('is unknown without the start, and for anything but Stop', () => {
    expect(stoppedAfterSec({ ...sent, endedAt: 9_000, ended: 'stopped' })).toBeNull();
    expect(stoppedAfterSec({ ...sent, ringingAt: 2_000, endedAt: 32_000, ended: 'rang_out' })).toBeNull();
  });
});

describe('ringOutcome', () => {
  it('says what their phone said', () => {
    expect(ringOutcome({ phase: 'sending', stoppedAfterSec: null })).toBe('waiting for their phone to say it’s ringing');
    expect(ringOutcome({ phase: 'ringing', stoppedAfterSec: null })).toBe('ringing on their phone now');
    expect(ringOutcome({ phase: 'stopped', stoppedAfterSec: 8 })).toBe('Stop was tapped on their phone after 8 seconds');
    expect(ringOutcome({ phase: 'stopped', stoppedAfterSec: 1 })).toBe('Stop was tapped on their phone after 1 second');
    expect(ringOutcome({ phase: 'stopped', stoppedAfterSec: null })).toBe('Stop was tapped on their phone');
    expect(ringOutcome({ phase: 'rang_out', stoppedAfterSec: null })).toBe('it rang for 30 seconds and nobody tapped Stop');
    expect(ringOutcome({ phase: 'rang', stoppedAfterSec: null })).toBe('it rang on their phone');
    expect(ringOutcome({ phase: 'no_answer', stoppedAfterSec: null })).toMatch(/^their phone didn’t say it rang\. .*latest OurHome app\.$/);
  });
});
