// tests/admin/sms-subscribers-logic.test.ts — the pure parts of the SMS subscriber console, plus
// the structural guarantee that keeps real phone numbers off the wire.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  displayChildAges,
  displayPostalCode,
  summariseSubscribers,
  type SmsSubscriberListRow,
} from '@/lib/admin/sms-subscribers';

function row(over: Partial<SmsSubscriberListRow> = {}): SmsSubscriberListRow {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    shortRef: '1',
    phoneNumber: '+16045550123',
    purged: false,
    postalCode: 'V5N 1A1',
    birthYears: [2019, 2022],
  isTest: false,
    status: 'active',
    consentMethod: 'web_form',
    consentTimestamp: '2026-08-01T00:00:00.000Z',
    confirmedTimestamp: '2026-08-01T00:05:00.000Z',
    consecutiveEmptyWeeks: 0,
    stoppedAt: null,
    ...over,
  };
}

describe('the summary counts what the table below it is actually showing', () => {
  it('counts each status', () => {
    const s = summariseSubscribers([
      row({ status: 'active' }),
      row({ status: 'active' }),
      row({ status: 'pending' }),
      row({ status: 'paused' }),
      row({ status: 'stopped', stoppedAt: '2026-08-02T00:00:00.000Z' }),
    ]);
    expect(s).toMatchObject({ total: 5, active: 2, pending: 1, paused: 1, stopped: 1 });
  });

  it('🔴 counts purged INDEPENDENTLY of status — the two are different questions', () => {
    // A purged row keeps its consent record and its 'stopped' status; only the personal columns
    // are erased. Folding "purged" into a status count would hide either one behind the other.
    const s = summariseSubscribers([
      row({ status: 'stopped', purged: true, phoneNumber: null }),
      row({ status: 'stopped', purged: false }),
    ]);
    expect(s.stopped).toBe(2);
    expect(s.purged).toBe(1);
  });

  it('is empty-safe', () => {
    expect(summariseSubscribers([])).toEqual({
      total: 0, active: 0, pending: 0, paused: 0, stopped: 0, purged: 0,
    });
  });
});

describe('🔴 the page stays server-only, which is what keeps numbers out of the browser', () => {
  // COMMENTS STRIPPED FIRST. The page's own header explains why it must not be a client
  // component, quoting the directive to do so — so a naive match finds the prose and fails on a
  // correct file. (This test caught exactly that on its first run.) The assertion has to be about
  // the CODE, not about whether anyone described the rule.
  const raw = readFileSync('app/admin/sms-subscribers/page.tsx', 'utf8');
  const page = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it("has no 'use client' directive", () => {
    // Not style policing. A client component would ship the rendered rows — real phone numbers —
    // into the browser bundle and into reach of any client-side analytics or error capture added
    // later. Server-only is the guarantee that survives someone wiring one up.
    expect(page).not.toMatch(/['"]use client['"]/);
  });

  it('pulls its data from the server-only module, not an API route', () => {
    expect(page).toContain("from '@/lib/admin/sms-subscribers'");
    expect(page).not.toMatch(/fetch\(/);
  });

  it('is gated by the shared admin choke point and 404s when refused', () => {
    expect(page).toContain('resolveAdminAccess');
    expect(page).toContain('notFound()');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE TRI-STATE: purged / absent / present, for the two columns added for Jon on 2026-09-18.
// ═══════════════════════════════════════════════════════════════════════════════════════════
const NOW = new Date('2026-09-18T12:00:00-07:00');

describe('postal code', () => {
  it('renders the FULL value, not an FSA', () => {
    // Deliberate divergence from lib/admin/sms-engagement.ts (groups BY fsa) and
    // scripts/friday-preview-real-subscribers.ts (prints the FSA because its output is relayed
    // off this host). Neither applies to a gated admin row that already shows the full E.164
    // phone number, which is a stronger identifier than the postal code beside it. Pinned as a
    // test so a future "harden the admin page" sweep has to change this assertion on purpose.
    expect(displayPostalCode(row())).toEqual({ text: 'V5N 1A1', muted: false });
  });

  it('🔴 says "purged" rather than going blank when retention erased it', () => {
    // The whole point of the `purged` flag: "we deleted this on purpose" and "something went
    // wrong" must never render identically. lib/retention/sms.ts NULLs phone_number, postal_code
    // and birth_years in ONE statement, so the flag derived from the phone is authoritative here.
    expect(displayPostalCode(row({ purged: true, postalCode: null, phoneNumber: null }))).toEqual({
      text: 'purged',
      muted: true,
    });
  });

  it('distinguishes "never given" from "erased"', () => {
    const absent = displayPostalCode(row({ postalCode: null }));
    expect(absent.muted).toBe(true);
    expect(absent.text).not.toBe('purged');
  });
});

describe('kids’ ages', () => {
  it('converts stored birth YEARS into ages at now', () => {
    expect(displayChildAges(row({ birthYears: [2019, 2022] }), NOW)).toEqual({
      text: '7, 4',
      muted: false,
    });
  });

  it('🔴 agrees with the helper the parent’s own preferences page uses', async () => {
    // The admin console and the no-login hub must not print two different ages for one child.
    // Asserting against the shared helper directly is what makes that a guarantee rather than a
    // coincidence of two implementations that currently happen to match.
    const { agesFromBirthYears } = await import('@/lib/sms/signup-validate');
    const years = [2015, 2020, 2024];
    expect(displayChildAges(row({ birthYears: years }), NOW).text).toBe(
      agesFromBirthYears(years, NOW).join(', ')
    );
  });

  it('🔴 says "purged" rather than blank when retention erased them', () => {
    expect(displayChildAges(row({ purged: true, birthYears: null, phoneNumber: null }), NOW)).toEqual(
      { text: 'purged', muted: true }
    );
  });

  it('distinguishes a parent who gave no ages from a purged row', () => {
    for (const empty of [null, [] as number[]]) {
      const d = displayChildAges(row({ birthYears: empty }), NOW);
      expect(d.muted).toBe(true);
      expect(d.text).not.toBe('purged');
    }
  });

  it('🔴 QA N1 — flags a PARTIALLY corrupt row instead of silently dropping the bad year', () => {
    // The regression this pins: [2021, 3000] used to render a confident, unmuted "5" — the second
    // child gone with no signal at all. A partially-bad row is the WORSE case, because unlike an
    // all-bad row it looks entirely normal, so nobody goes looking. An admin must be able to tell
    // "this family has one child aged 5" apart from "we are holding something broken for them".
    const d = displayChildAges(row({ birthYears: [2021, 3000] }), NOW);
    expect(d.text).toContain('5'); // the readable age is still stated
    expect(d.text).toContain('unreadable');
    expect(d.text).toContain('3000'); // the raw stored value, so it can be acted on
    expect(d.text).not.toBe('5'); // the exact shape of the original bug
  });

  it('counts how many years were dropped, for more than one bad value', () => {
    const d = displayChildAges(row({ birthYears: [2021, 3000, 4000] }), NOW);
    expect(d.text).toContain('2 unreadable');
  });

  it('stays UNMUTED when a real age survives — muted means "this explains an absence"', () => {
    // Greying the one row worth investigating would bury it among the purged/never-given rows.
    expect(displayChildAges(row({ birthYears: [2021, 3000] }), NOW).muted).toBe(false);
  });

  it('does not flag a clean row', () => {
    // Guard against the fix firing on healthy data: no "unreadable", no separator noise.
    const d = displayChildAges(row({ birthYears: [2019, 2022] }), NOW);
    expect(d.text).toBe('7, 4');
    expect(d.text).not.toContain('unreadable');
  });

  it('🔴 derives the dropped count from the shared helper, not a second copy of its rule', async () => {
    // stored.length - ages.length is exact because agesFromBirthYears maps then filters. If this
    // module ever restates the ">= 0" predicate itself, the two definitions can drift apart and
    // this assertion is the thing that should start failing.
    const { agesFromBirthYears } = await import('@/lib/sms/signup-validate');
    const years = [2021, 3000, 2018];
    const surviving = agesFromBirthYears(years, NOW).length;
    expect(displayChildAges(row({ birthYears: years }), NOW).text).toContain(
      `${years.length - surviving} unreadable`
    );
  });

  it('🔴 shows an unreadable birth year RAW instead of hiding it', () => {
    // agesFromBirthYears drops a future year, because a parent should never read "age -1". An
    // admin is the opposite reader: they are the one who needs to see that the row holds
    // something impossible. Dropping it here would erase the only signal that it is there.
    const d = displayChildAges(row({ birthYears: [2099] }), NOW);
    expect(d.text).toContain('2099');
    expect(d.muted).toBe(true);
  });
});

describe('🔴 the list page renders the new columns from the read model', () => {
  const raw = readFileSync('app/admin/sms-subscribers/page.tsx', 'utf8');
  const page = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('uses the shared tri-state helpers rather than its own ternaries', () => {
    expect(page).toContain('displayPostalCode');
    expect(page).toContain('displayChildAges');
  });

  it('does not compute ages inline', () => {
    // A second copy of `currentYear - birthYear` in JSX is how this page starts disagreeing with
    // the picker on New Year's Eve — the shared helper reads the year in America/Vancouver.
    expect(page).not.toMatch(/getFullYear\s*\(\s*\)\s*-/);
  });
});
