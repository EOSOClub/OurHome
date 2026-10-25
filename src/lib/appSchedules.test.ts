import { describe, expect, it } from 'vitest';
import { clockValue, daysLabel, formatClock, parseClock, scheduleTimes, schedulesSummary } from './appSchedules';

describe('schedules', () => {
  it('writes times of day on a 12-hour clock, and reads a time input', () => {
    expect(formatClock(0)).toBe('12:00 AM');
    expect(formatClock(7 * 60 + 5)).toBe('7:05 AM');
    expect(formatClock(12 * 60)).toBe('12:00 PM');
    expect(formatClock(21 * 60 + 30)).toBe('9:30 PM');
    expect(clockValue(7 * 60 + 5)).toBe('07:05');
    expect(parseClock('21:30')).toBe(1290);
    expect(parseClock('7:05')).toBe(425);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('')).toBeNull();
  });

  it('names the usual sets of days, and lists any others', () => {
    expect(daysLabel([6, 5, 4, 3, 2, 1, 0])).toBe('Every day');
    expect(daysLabel([1, 2, 3, 4, 5])).toBe('Weekdays');
    expect(daysLabel([0, 6])).toBe('Weekends');
    expect(daysLabel([5, 1, 3, 3])).toBe('Mon, Wed, Fri');
  });

  it('says when a schedule runs past midnight, and sums them up for the card', () => {
    expect(scheduleTimes(21 * 60, 7 * 60)).toBe('9:00 PM to 7:00 AM (next day)');
    expect(scheduleTimes(8 * 60, 15 * 60)).toBe('8:00 AM to 3:00 PM');
    expect(schedulesSummary([])).toBeNull();
    expect(schedulesSummary([{ name: 'Bedtime', start: 1260, end: 420 }])).toBe('Bedtime 9:00 PM to 7:00 AM');
    expect(
      schedulesSummary([
        { name: 'Bedtime', start: 1260, end: 420 },
        { name: 'School', start: 480, end: 900 },
      ]),
    ).toBe('2 schedules');
  });
});
