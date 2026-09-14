// tests/sms/instant_picks_send_log_invariants.test.ts — the two things adding a fifth send_type
// must NOT do (plan v2.0 §3.4 and §9 risk 4, task 6).
//
// ═══ WHY THESE NEED A TEST RATHER THAN A COMMENT: BOTH FAILURES ARE INVISIBLE ═══
// Each of the two edits below is a one-line change that a reasonable developer would make for a
// good-sounding reason, that breaks something in a DIFFERENT feature, and that leaves every other
// test in this repo green.
//
//   1. ADDING 'instant_picks' TO `findLastWeek`'s IN-LIST. Reason it looks right: "the Last Friday
//      panel should show the most recent message we sent." Consequence: the Instant Picks button
//      sits INSIDE that panel, so a parent's own button press comes back at them as though we had
//      decided to text them — and PRD §6's send and click-through metrics start counting a
//      different kind of message. Nothing errors. The panel just starts lying.
//
//   2. WIDENING `sms_send_log_picks_only_weekly` SO AN ON-DEMAND ROW CAN CARRY A SNAPSHOT. Reason
//      it looks right: "record what we actually sent." Consequence: lib/sms/weekly-send-io.ts's
//      novelty filter queries `send_type = 'weekly' AND picks_snapshot IS NOT NULL` and its own
//      comment calls those "the same condition twice" — TRUE ONLY WHILE THIS CONSTRAINT HOLDS.
//      Widen it and a Wednesday button press silently suppresses those activities from Friday's
//      REAL text. lib/sms/click-through.ts's hub attribution rests on the same invariant.
//      Nothing errors. Friday just gets quietly worse.
//
// STATIC, over the source and the migrations, because that is where the edits would be made. The
// behavioural half — that the database actually rejects a snapshot on an on-demand row — is in
// tests/sms/instant_picks_send_log-db.test.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findLastWeek } from '@/lib/sms/preferences';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(ROOT + rel, 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** SQL block comments are `--` lines here, not `//`. */
const stripSqlComments = (src: string) => src.replace(/^\s*--.*$/gm, '');

const SEND_TYPE = 'instant_picks';

describe('1 · the "Last Friday" panel must not select on-demand rows', () => {
  const src = stripComments(read('/lib/sms/preferences.ts'));

  it('findLastWeek still filters to exactly the three types WE initiate', () => {
    expect(src).toMatch(/send_type IN \('weekly','empty_week','pause_notice'\)/);
  });

  it('and does not mention the on-demand type anywhere in its SQL', () => {
    // Scoped to the statements rather than the file, so the module may still DISCUSS the rule.
    for (const statement of src.match(/`[^`]*sms_send_log[^`]*`/g) ?? []) {
      expect(statement).not.toContain(SEND_TYPE);
    }
  });

  it('the panel’s own type union cannot represent an on-demand row', () => {
    // The strongest form: even if the SQL were edited, the value has nowhere to land. `LastWeekKind`
    // is the panel's vocabulary and it deliberately does not include this.
    const union = /type LastWeekKind =([^;]+);/.exec(src);
    expect(union).not.toBeNull();
    expect(union![1]).not.toContain(SEND_TYPE);
  });

  it('findLastWeek is still exported and is still the one reader of that panel', () => {
    // A sanity check on the assertions above: if this function were renamed or deleted, every
    // regex here would pass vacuously.
    expect(typeof findLastWeek).toBe('function');
  });
});

describe('2 · picks_snapshot stays weekly-only', () => {
  it('migration 0035 declared the constraint and no later migration widens it', () => {
    expect(read('/supabase/migrations/0035_sms_send_log.sql'))
      .toMatch(/CHECK \(picks_snapshot IS NULL OR send_type = 'weekly'\)/);
  });

  it('NO migration anywhere adds a send_type to that constraint', () => {
    // The edit this test exists to stop, wherever it might be made. A migration that mentions both
    // `picks_snapshot` and our send_type in one CHECK is the widening, whatever it is called.
    const files = readMigrations();
    for (const [name, sql] of files) {
      const body = stripSqlComments(sql);
      for (const check of body.match(/CHECK\s*\([^;]*?\)/gis) ?? []) {
        if (check.includes('picks_snapshot')) {
          expect(check, `${name} widens the picks_snapshot rule`).not.toContain(SEND_TYPE);
        }
      }
    }
  });

  it('0049 drops the send_type ENUMERATION only, never the snapshot rule', () => {
    const sql = read('/supabase/migrations/0049_sms_send_log_instant_picks.sql');
    const body = stripSqlComments(sql);
    // ⚠ THE TRAP THIS ASSERTS AGAINST: `sms_send_log` has TWO check constraints whose definition
    // mentions `send_type`, and the obvious transliteration of migration 0046's DROP-by-expression
    // pattern (`ILIKE '%send_type%'`) matches BOTH — so it would drop the snapshot rule and the
    // ADD would only put one back. The predicate must exclude it.
    expect(body).toMatch(/NOT ILIKE '%picks_snapshot%'/);
    // And the migration verifies its own work rather than trusting the predicate.
    expect(body).toMatch(/sms_send_log_picks_only_weekly/);
    expect(body).toMatch(/RAISE EXCEPTION/);
  });

  it('the send path passes a literal null and has no branch that could pass anything else', () => {
    const src = stripComments(read('/lib/sms/instant-picks-send.ts'));
    expect(src).toMatch(/picksSnapshot:\s*null/);
    expect(src).not.toMatch(/picksSnapshot:(?!\s*null\b)/);
  });
});

describe('3 · the send_type mirror and its constraint agree', () => {
  it('SendLogType admits the new value', () => {
    expect(stripComments(read('/lib/sms/send-log.ts'))).toMatch(/'instant_picks'/);
  });

  it('migration 0049’s enumeration lists every member of SendLogType', () => {
    // ⚠ A TYPE AND A CHECK CONSTRAINT ARE TWO SOURCES OF TRUTH FOR ONE VOCABULARY, and they drift
    // silently: TypeScript is happy, and the INSERT fails at runtime for the one send that used
    // the new value. This is the only thing that couples them.
    const union = /export type SendLogType =([\s\S]*?);\n/.exec(read('/lib/sms/send-log.ts'));
    expect(union).not.toBeNull();
    const members = [...union![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(members.length).toBeGreaterThanOrEqual(6);

    const add = /ADD CONSTRAINT sms_send_log_send_type_check[\s\S]*?\);/
      .exec(read('/supabase/migrations/0049_sms_send_log_instant_picks.sql'));
    expect(add).not.toBeNull();
    for (const member of members) {
      expect(add![0], `send_type '${member}' is in the TS union but not in the CHECK`)
        .toContain(`'${member}'`);
    }
  });

  it('ThrottleScope and migration 0048’s scope enumeration agree too', () => {
    const union = /export type ThrottleScope =([\s\S]*?);\n/.exec(read('/lib/sms/throttle.ts'));
    expect(union).not.toBeNull();
    const members = [...union![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(members).toContain('instant_picks_sms');
    expect(members).toContain('instant_picks_sms_ip');

    const add = /ADD CONSTRAINT sms_signup_throttle_scope_check[\s\S]*?\);/
      .exec(read('/supabase/migrations/0048_sms_throttle_instant_picks_sms.sql'));
    expect(add).not.toBeNull();
    for (const member of members) {
      expect(add![0], `scope '${member}' is in the TS union but not in the CHECK`)
        .toContain(`'${member}'`);
    }
  });
});

describe('4 · task 1 is HELD, and nothing here reached into it', () => {
  // ⚠ THE BOUNDARY, ASSERTED RATHER THAN PROMISED. Tasks 2–8 were built while task 1 — the new
  // disclosure wording, the CONSENT_TEXT_VERSION bump, and the enablement decision — waits on the
  // Toll-Free Verification status. These four assertions are what stop that boundary being crossed
  // by accident, in this change or in a later one that quietly "finishes the job".
  const copy = read('/lib/sms/consent-copy.ts');

  it('the frequency disclosure is untouched', () => {
    expect(copy).toContain(
      "'1 message per week, plus a one-time confirmation message.'"
    );
  });

  it('CONSENT_TEXT_VERSION is still v7', () => {
    expect(copy).toContain("export const CONSENT_TEXT_VERSION = '2026-09-03.v7';");
  });

  it('carrierDisclosuresFor still strips exactly the one frequency line', () => {
    // The area-waitlist surface removes the frequency sentence and NOTHING ELSE, by exact match.
    // Rewriting that sentence as a paragraph fused with something else would break this surface —
    // which is a task 1 consideration, recorded here because task 1 lands on top of this code.
    expect(stripComments(copy)).toMatch(
      /CARRIER_DISCLOSURES\.filter\(\(line\) => line !== MESSAGE_FREQUENCY_DISCLOSURE\)/
    );
  });

  it('the send path is gated on a version that does not exist yet', () => {
    const src = stripComments(read('/lib/sms/instant-picks-send.ts'));
    expect(src).toMatch(/INSTANT_PICKS_MIN_CONSENT_SERIAL = 8/);
    expect(src).toMatch(/serial < INSTANT_PICKS_MIN_CONSENT_SERIAL/);
  });

  it('the dedicated switch is NOT SMS_SENDING_ENABLED', () => {
    // ⚠ SMS_SENDING_ENABLED is already `true` in production — it gates the Friday weekly send — so
    // reusing it would have made this feature live the moment it merged.
    const config = read('/lib/sms/config.ts');
    expect(config).toMatch(/INSTANT_PICKS_SMS_SEND_ENABLED/);
    const fn = /export function instantPicksSmsSendEnabled\(\)[\s\S]*?\n}/.exec(config);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('INSTANT_PICKS_SMS_SEND_ENABLED');
    expect(fn![0]).not.toContain('SMS_SENDING_ENABLED');
  });
});

/** Every migration file, so "no migration anywhere does X" is a real statement. */
function readMigrations(): Array<[string, string]> {
  const dir = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')] as [string, string]);
}
