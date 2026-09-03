// tests/activity-detail-redundancy.test.ts — the three redundancies Jon asked to remove from the
// activity page (2026-09-03), and the one rule among them that needed judgement.
import { describe, expect, it } from 'vitest';
import { isAgeNoteRestatement } from '../app/preview/_data/format';

describe('🔴 parent notes are no longer manufactured', () => {
  const code = (require('node:fs').readFileSync('app/preview/_data/search-api.ts', 'utf8') as string)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('the mapper emits an empty array, not a Source/Status pair', () => {
    // Every listing used to get [`Source: …`, `Status: …`], so the panel was never empty and never
    // once held a parent note. Both strings restate the "Source & freshness" panel directly below.
    expect(code).toMatch(/parentNotes: \[\],/);
    expect(code).not.toMatch(/parentNotes: \[`Source/);
  });

  it('🔴 fixed at the data layer, not filtered in the UI', () => {
    // ActivityDetail already guarded `parentNotes.length > 0`; the panel only ever rendered because
    // the mapper guaranteed a non-empty array. Filtering those two strings out downstream would
    // have left the fiction in the data for every future consumer to re-exclude.
    const detail = require('node:fs').readFileSync(
      'app/preview/_components/ActivityDetail.tsx',
      'utf8'
    ) as string;
    expect(detail).toMatch(/activity\.parentNotes\.length > 0/);
    expect(detail).not.toMatch(/filter[\s\S]{0,40}Source:/);
  });
});

describe('🔴 the age range is stated once, not three times', () => {
  const detail = (require('node:fs').readFileSync('app/preview/_components/ActivityDetail.tsx', 'utf8') as string)
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it('the Who-it-is-for panel shows the band only — the stat row already gave the range', () => {
    expect(detail).toMatch(/<p className="kf-guide__band">\{ages\.band\}<\/p>/);
    expect(detail).not.toMatch(/\{ages\.range\} · \{ages\.band\}/);
  });

  it('the decorative icon is gone entirely', () => {
    // aria-hidden, so it said nothing to a screen reader and only decorated a sentence that
    // already states the fact. Jon: remove, not shrink or hide on desktop.
    expect(detail).not.toMatch(/meta\.icon/);
  });
});

describe('🔴 isAgeNoteRestatement suppresses the echo WITHOUT eating real notes', () => {
  // The judgement call. Suppressing whenever the range is unspecified would have dropped the third
  // restatement AND genuinely useful notes, which appear on exactly those listings most often.
  it('suppresses a recognised all-ages restatement when the range says nothing', () => {
    expect(isAgeNoteRestatement('all-ages', true)).toBe(true);
    expect(isAgeNoteRestatement('All Ages', true)).toBe(true);
    expect(isAgeNoteRestatement('no age limit', true)).toBe(true);
  });

  it('🔴 does NOT suppress a note that adds real information', () => {
    // The failure mode that matters. These appear on all-ages listings constantly, and losing them
    // would make the page less useful in the name of making it less repetitive.
    expect(isAgeNoteRestatement('Under 5 must be accompanied by an adult', true)).toBe(false);
    expect(isAgeNoteRestatement('Helmets required for under-12s', true)).toBe(false);
    expect(isAgeNoteRestatement('Parent participation required', true)).toBe(false);
  });

  it('🔴 does NOT suppress anything when the range IS specified', () => {
    // If the source gave a real range, its note qualifies that range rather than restating nothing.
    expect(isAgeNoteRestatement('all-ages', false)).toBe(false);
  });

  it('handles absent notes without throwing', () => {
    expect(isAgeNoteRestatement(null, true)).toBe(false);
    expect(isAgeNoteRestatement(undefined, true)).toBe(false);
    expect(isAgeNoteRestatement('', true)).toBe(false);
  });
});

describe('🔴 Booking is suppressed when it merely repeats Status', () => {
  const detail = (require('node:fs').readFileSync('app/preview/_components/ActivityDetail.tsx', 'utf8') as string)
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it('guards on BOTH causes — an empty tag and a tag equal to the status label', () => {
    // Two separate paths produced the same visible duplication. The first was the '' fallback to
    // meta.label. The second, found while verifying the first, is a REAL booking value that reads
    // identically to the status ("Bookable now" on both). A fix for either alone leaves the other.
    expect(detail).toMatch(/bookingTag\(activity\.booking\) &&\s*bookingTag\(activity\.booking\) !== meta\.label/);
  });

  it('🔴 does not fall back to meta.label as the VALUE — that was the original bug', () => {
    expect(detail).not.toMatch(/label="Booking" value=\{bookingTag\(activity\.booking\) \|\| meta\.label\}/);
  });
});
