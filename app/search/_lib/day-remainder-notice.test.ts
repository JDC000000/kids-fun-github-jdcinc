import { describe, expect, it } from 'vitest';
import { describeDayRemainder } from './day-remainder-notice';
import type { DayWindowState, RequestedDayWindow } from '@/lib/search/day-window';

const win = (state: DayWindowState, isToday = true): RequestedDayWindow => ({
  isoDate: '2026-08-17',
  isToday,
  state,
});

describe('describeDayRemainder', () => {
  it('says nothing when the engine reported no single-day window', () => {
    expect(describeDayRemainder(null, { resultCount: 0 })).toBeNull();
    expect(describeDayRemainder(undefined, { resultCount: 0 })).toBeNull();
  });

  it('says nothing about an ordinary well-filled Today', () => {
    expect(describeDayRemainder(win('day_ahead'), { resultCount: 42 })).toBeNull();
  });

  it('says nothing about a future day — it is entirely ahead', () => {
    expect(describeDayRemainder(win('day_ahead', false), { resultCount: 0 })).toBeNull();
  });

  // THE POINT OF THE WHOLE MODULE. Two empty pages, two completely different reasons, and the
  // parent must be able to tell which one they are looking at.
  it('renders "the day has run out" and "nothing is on" as different messages', () => {
    const over = describeDayRemainder(win('day_over'), { resultCount: 0 });
    const ahead = describeDayRemainder(win('day_ahead'), { resultCount: 0 });
    expect(over).not.toBeNull();
    expect(ahead).not.toBeNull();
    expect(over!.lede).not.toBe(ahead!.lede);
    expect(over!.body).not.toBe(ahead!.body);
  });

  it('does not claim the day is over while some of it is still ahead', () => {
    const closing = describeDayRemainder(win('day_closing'), { resultCount: 8 })!;
    expect(closing.lede).not.toMatch(/over|finished/i);
    // …and it explicitly declines to say how busy the day was, because nothing knows that.
    expect(closing.body).toMatch(/cannot tell you/i);
  });

  it('does not claim anything has finished while most of the day is still ahead', () => {
    const ahead = describeDayRemainder(win('day_ahead'), { resultCount: 0 })!;
    expect(ahead.body).toMatch(/not a case of activities having already finished/i);
  });

  it('offers tomorrow explicitly whenever the requested day is today', () => {
    for (const state of ['day_ahead', 'day_closing', 'day_over'] as DayWindowState[]) {
      const notice = describeDayRemainder(win(state), { resultCount: 0 });
      expect(notice?.offerTomorrow).toBe(true);
    }
  });

  it('explains a past date without offering "tomorrow", which would mean the wrong day', () => {
    const past = describeDayRemainder(win('day_over', false), { resultCount: 0 })!;
    expect(past.lede).toMatch(/passed/i);
    expect(past.offerTomorrow).toBe(false);
  });

  // A thin evening list is the exact shape the testers reported, and it must be disclosed even
  // though the page is not empty — a near-empty page that says nothing is the defect.
  it('discloses a thin evening list even though results are present', () => {
    expect(describeDayRemainder(win('day_closing'), { resultCount: 8 })).not.toBeNull();
    expect(describeDayRemainder(win('day_over'), { resultCount: 8 })).not.toBeNull();
  });
});
