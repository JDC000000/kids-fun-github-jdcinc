// tests/sms/consent_transitions.test.ts — the four inbound state transitions.
//
// The database is injected, so every row state is reachable without one: `findByPhone` hands the
// decision a row (or null), `applyChange` records what would have been written. The DECISIONS are
// pure and are also tested directly, because they are the part that must be right — they are the
// documented WHERE clauses expressed as functions.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldSendWelcome } from '@/app/api/sms/inbound/route';
import {
  type ConsentWriteOutcome,
  confirmSubscriber,
  decideConfirm,
  decideStart,
  decideStop,
  mirrorCarrierStart,
  mirrorCarrierStop,
  recordHelpRequest,
  type ConsentChange,
  type ConsentRow,
  type ConsentStatus,
  type SubscriberLookup,
  type TransitionOptions,
} from '@/lib/sms/consent-transitions';

// ═══ THE UNIT LANE DOES NOT TOUCH A DATABASE ═══
// Stage A made the consent seams real: they now issue actual SQL through lib/db/client. This file
// tests decisions and wiring, not persistence, so the db seam is mocked to an empty result — which
// restores exactly the "finds nothing" world these tests were written against, honestly and
// without a connection. The real seams are covered in tests/sms/signup_persistence-db.test.ts,
// which runs in the `db` lane. That split is the convention vitest.workspace.ts documents.
vi.mock('@/lib/db/client', () => ({
  query: async () => [],
  getPool: () => {
    throw new Error('the unit lane must not open a pool');
  },
}));


const PHONE = '+16045550123';
const STOPPED_AT = new Date('2026-08-10T00:00:00Z');
const NOW = new Date('2026-08-28T23:00:00Z');

function row(status: ConsentStatus, over: Partial<ConsentRow> = {}): ConsentRow {
  return {
    id: 'sub-1',
    status,
    stoppedAt: status === 'stopped' ? STOPPED_AT : null,
    ...over,
  };
}

/** A lookup that always returns this row. `null` models "no row holds this number". */
function finds(found: ConsentRow | null): SubscriberLookup {
  return async () => found;
}

/**
 * Records every write the transition attempted.
 *
 * `outcome` is what the applier reports back — 'applied' by default (the compare-and-set held),
 * 'no_match' to simulate losing a concurrent race. See the concurrency block at the end of this
 * file.
 */
function recorder(outcome: ConsentWriteOutcome = 'applied') {
  const writes: ConsentChange[] = [];
  return {
    writes,
    applyChange: async (change: ConsentChange): Promise<ConsentWriteOutcome> => {
      writes.push(change);
      return outcome;
    },
  };
}

/** Live mode: writing enabled, so `applied` is reachable. */
function live(found: ConsentRow | null, extra: Partial<TransitionOptions> = {}) {
  const rec = recorder();
  return {
    rec,
    options: {
      dryRun: false,
      now: NOW,
      findByPhone: finds(found),
      applyChange: rec.applyChange,
      ...extra,
    } as TransitionOptions,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// JOIN
// ─────────────────────────────────────────────────────────────────────────────

describe('JOIN — the CASL express-consent confirmation', () => {
  it('REACTIVATES a stopped subscriber still inside the 30-day window, without a second row', () => {
    // sms_consent has a UNIQUE index on phone_number, and a parent who stopped inside retention
    // still owns that row. Consent is per NUMBER, not per row — so this must revive the existing
    // row rather than insert. The change is keyed on the FOUND id, which is what proves it.
    const decision = decideConfirm(row('stopped'));
    expect(decision).toEqual({
      outcome: 'applied',
      subscriberId: 'sub-1',
      change: {
        subscriberId: 'sub-1',
        // The status the decision READ — the compare-and-set predicate. See ConsentChange.
        expectedStatus: 'stopped',
        status: 'active',
        stoppedAt: 'clear', // the row comes back to life
        reconsent: true, // re-stamped with TODAY's wording
        confirm: true, // confirmed_timestamp — the double-opt-in reply
      },
    });
  });

  it('writes exactly that change, once, against the existing row id', async () => {
    const { rec, options } = live(row('stopped'));
    const result = await confirmSubscriber(PHONE, options);

    expect(result.outcome).toBe('applied');
    expect(result.subscriberId).toBe('sub-1');
    expect(rec.writes).toHaveLength(1);
    expect(rec.writes[0].subscriberId).toBe('sub-1');
    expect(rec.writes[0].stoppedAt).toBe('clear');
  });

  it('also revives a paused subscriber, and confirms a pending one', async () => {
    for (const status of ['pending', 'paused'] as ConsentStatus[]) {
      const { rec, options } = live(row(status));
      const result = await confirmSubscriber(PHONE, options);
      expect(result.outcome).toBe('applied');
      expect(rec.writes[0].status).toBe('active');
      expect(rec.writes[0].confirm).toBe(true);
    }
  });

  it('from an UNKNOWN number is no_such_subscriber — not an error, and nothing is written', async () => {
    // Means a purged pending signup (the 90-day rule) or someone texting JOIN cold. The route
    // replies with the signup link. We must NOT mint a subscription from an inbound text alone:
    // we would hold no record of what consent language they ever saw, and consent_text_version is
    // NOT NULL for exactly that reason.
    const { rec, options } = live(null);
    const result = await confirmSubscriber(PHONE, options);

    expect(result.outcome).toBe('no_such_subscriber');
    expect(result.subscriberId).toBeNull();
    expect(result.change).toBeNull();
    expect(result.error).toBeUndefined();
    expect(rec.writes).toEqual([]);
  });

  it('from an ALREADY-ACTIVE subscriber writes nothing', async () => {
    const { rec, options } = live(row('active'));
    const result = await confirmSubscriber(PHONE, options);
    expect(result.outcome).toBe('already_in_state');
    expect(result.subscriberId).toBe('sub-1');
    expect(rec.writes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STOP
// ─────────────────────────────────────────────────────────────────────────────

describe('STOP — mirroring the carrier suppression', () => {
  it('stamps stopped_at on a first stop, which starts the 30-day purge clock', async () => {
    const { rec, options } = live(row('active'));
    const result = await mirrorCarrierStop(PHONE, options);

    expect(result.outcome).toBe('applied');
    expect(rec.writes[0]).toEqual({
      subscriberId: 'sub-1',
      expectedStatus: 'active',
      status: 'stopped',
      stoppedAt: 'set',
      reconsent: false,
      confirm: false,
    });
  });

  it('a REPEAT STOP is already_in_state and does NOT re-stamp stopped_at', async () => {
    // THE BUG THIS TEST EXISTS FOR. Repeat STOPs are normal — a number already suppressed at the
    // carrier can still have STOP texted at it again. Re-stamping stopped_at would push the
    // 30-day purge deadline out every single time, quietly extending a retention promise.
    const { rec, options } = live(row('stopped'));
    const result = await mirrorCarrierStop(PHONE, options);

    expect(result.outcome).toBe('already_in_state');
    expect(result.subscriberId).toBe('sub-1');
    expect(result.change).toBeNull();
    expect(rec.writes).toEqual([]); // no UPDATE at all — the deadline cannot move
  });

  it('stops a paused subscriber too — paused is not stopped', async () => {
    const { rec, options } = live(row('paused'));
    expect((await mirrorCarrierStop(PHONE, options)).outcome).toBe('applied');
    expect(rec.writes[0].status).toBe('stopped');
    expect(rec.writes[0].stoppedAt).toBe('set');
  });

  it('from an unknown number is no_such_subscriber, not an error', async () => {
    const result = await mirrorCarrierStop(PHONE, live(null).options);
    expect(result.outcome).toBe('no_such_subscriber');
    expect(result.error).toBeUndefined();
  });

  it('never re-stamps: decideStop returns no change at all for a stopped row', () => {
    // Asserted on the pure decision as well, because this is the property that must survive any
    // future refactor of the wrapper.
    expect(decideStop(row('stopped'))).toEqual({
      outcome: 'already_in_state',
      subscriberId: 'sub-1',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

describe('START — mirroring the carrier un-suppression', () => {
  it('AFTER THE PURGE is no_such_subscriber — never a resurrection', async () => {
    // The 30-day purge NULLs phone_number in place, so the lookup's `WHERE phone_number = $1`
    // cannot match the row. It resolves to null by construction, with nothing testing for a
    // purge. Resuming here would be worse than useless: un-suppressing at the carrier does not
    // give back the postal code, ages and interests the weekly send needs, so we would text an
    // empty week forever.
    const { rec, options } = live(null);
    const result = await mirrorCarrierStart(PHONE, options);

    expect(result.outcome).toBe('no_such_subscriber');
    expect(result.subscriberId).toBeNull();
    expect(result.change).toBeNull();
    expect(rec.writes).toEqual([]);
  });

  it('resumes a stopped subscriber whose row is still intact', async () => {
    const { rec, options } = live(row('stopped'));
    const result = await mirrorCarrierStart(PHONE, options);

    expect(result.outcome).toBe('applied');
    expect(rec.writes[0]).toEqual({
      subscriberId: 'sub-1',
      expectedStatus: 'stopped',
      status: 'active',
      stoppedAt: 'clear',
      // NOT a re-consent. START is a carrier resume signal, not a fresh express-consent event;
      // re-stamping consent_timestamp would record a consent act that never happened, in the
      // columns an audit reads.
      reconsent: false,
      confirm: false,
    });
  });

  it('does NOT activate a PENDING row — that would bypass the double opt-in', async () => {
    // The fourth case the original comment did not name. Someone submitted the form, never
    // replied JOIN, now texts START. The documented UPDATE matches zero rows, correctly: START is
    // not the CASL confirmation. It is also not no_such_subscriber (the row is right there) and
    // not already_in_state (pending is not what START targets) — and the webhook's reply differs
    // in all three, which is why it gets its own outcome.
    const { rec, options } = live(row('pending'));
    const result = await mirrorCarrierStart(PHONE, options);

    expect(result.outcome).toBe('awaiting_confirmation');
    expect(result.subscriberId).toBe('sub-1');
    expect(result.change).toBeNull();
    expect(rec.writes).toEqual([]);
  });

  it('from an already-active subscriber writes nothing', async () => {
    const { rec, options } = live(row('active'));
    expect((await mirrorCarrierStart(PHONE, options)).outcome).toBe('already_in_state');
    expect(rec.writes).toEqual([]);
  });

  it('decideStart is total over every status', () => {
    expect(decideStart(null).outcome).toBe('no_such_subscriber');
    expect(decideStart(row('active')).outcome).toBe('already_in_state');
    expect(decideStart(row('pending')).outcome).toBe('awaiting_confirmation');
    expect(decideStart(row('stopped')).outcome).toBe('applied');
    expect(decideStart(row('paused')).outcome).toBe('applied');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HELP
// ─────────────────────────────────────────────────────────────────────────────

describe('HELP — a true no-op, deliberately', () => {
  it('changes nothing, writes nothing, and does not even look the number up', async () => {
    // Recommendation implemented rather than left open: Twilio sends the configured help text and
    // keeps the inbound record; sms_send_log is send-side by definition (0035) and a separate
    // inbound log is real surface for a signal no MVP metric consumes. See the function's own
    // comment for the full argument and for what would change it.
    const lookup = vi.fn(async () => row('active'));
    const rec = recorder();
    const result = await recordHelpRequest(PHONE, {
      dryRun: false,
      findByPhone: lookup,
      applyChange: rec.applyChange,
    });

    expect(result.outcome).toBe('no_change');
    expect(result.change).toBeNull();
    expect(rec.writes).toEqual([]);
    expect(lookup).not.toHaveBeenCalled(); // no read either — nothing to decide
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The dry-run gate, and the error path
// ─────────────────────────────────────────────────────────────────────────────

describe('the dry-run gate holds on every transition', () => {
  const transitions = [
    ['JOIN', confirmSubscriber, row('stopped')],
    ['STOP', mirrorCarrierStop, row('active')],
    ['START', mirrorCarrierStart, row('stopped')],
  ] as const;

  it('defaults to dry-run when SMS_SENDING_ENABLED is unset — nothing is written', async () => {
    for (const [, fn, found] of transitions) {
      const rec = recorder();
      // `dryRun` deliberately NOT passed: this asserts the DEFAULT, which is the thing an
      // unconfigured environment relies on.
      const result = await fn(PHONE, { findByPhone: finds(found), applyChange: rec.applyChange });
      expect(result.outcome).toBe('dry_run');
      expect(rec.writes).toEqual([]);
    }
  });

  it('still reports the change it WOULD have made', async () => {
    // A dry run that only said "dry_run" would be useless for the thing a dry run is for.
    const rec = recorder();
    const result = await confirmSubscriber(PHONE, {
      findByPhone: finds(row('stopped')),
      applyChange: rec.applyChange,
    });
    expect(result.outcome).toBe('dry_run');
    expect(result.change).toEqual({
      subscriberId: 'sub-1',
      expectedStatus: 'stopped',
      status: 'active',
      stoppedAt: 'clear',
      reconsent: true,
      confirm: true,
    });
  });

  it('permits a real write once SMS_SENDING_ENABLED is "true"', async () => {
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    const rec = recorder();
    const result = await mirrorCarrierStop(PHONE, {
      findByPhone: finds(row('active')),
      applyChange: rec.applyChange,
    });
    expect(result.outcome).toBe('applied');
    expect(rec.writes).toHaveLength(1);
  });

  it('does NOT mask the read-only outcomes behind dry_run', async () => {
    // `dry_run` means "we decided a change and did not write it", so it displaces only `applied`.
    // no_such_subscriber and already_in_state are facts about the database that are true whether
    // or not writing is enabled, and a dry run that hid them would be lying about what it found.
    expect((await confirmSubscriber(PHONE, { findByPhone: finds(null) })).outcome).toBe(
      'no_such_subscriber'
    );
    expect((await mirrorCarrierStop(PHONE, { findByPhone: finds(row('stopped')) })).outcome).toBe(
      'already_in_state'
    );
    expect((await mirrorCarrierStart(PHONE, { findByPhone: finds(row('pending')) })).outcome).toBe(
      'awaiting_confirmation'
    );
  });

  it('the DEFAULT seams are inert — an unwired call reads nothing and finds nothing', async () => {
    // No injected deps at all: the stubbed lookup returns null, so every transition lands on
    // no_such_subscriber rather than pretending to have done something.
    for (const [, fn] of transitions) {
      expect((await fn(PHONE, {})).outcome).toBe('no_such_subscriber');
    }
  });
});

describe('failures surface as error, and never leak', () => {
  it('classifies a failed lookup', async () => {
    const result = await confirmSubscriber(PHONE, {
      dryRun: false,
      findByPhone: async () => {
        throw new Error('connection terminated');
      },
    });
    expect(result.outcome).toBe('error');
    expect(result.error).toContain('lookup failed');
    expect(result.change).toBeNull();
  });

  it('classifies a failed write, and still reports the change it attempted', async () => {
    const result = await mirrorCarrierStop(PHONE, {
      dryRun: false,
      findByPhone: finds(row('active')),
      applyChange: async () => {
        throw new Error('deadlock detected');
      },
    });
    expect(result.outcome).toBe('error');
    expect(result.error).toContain('write failed');
    expect(result.subscriberId).toBe('sub-1');
    expect(result.change?.status).toBe('stopped');
  });

  it('never puts personal data in a result beyond the number the caller already had', async () => {
    // The route redacts the number before it logs anything (redactPhone), and nothing else about
    // the subscriber — postal code, ages, interests — is even visible to a decision function.
    const result = await confirmSubscriber(PHONE, { findByPhone: finds(row('stopped')) });
    expect(Object.keys(result).sort()).toEqual(['change', 'outcome', 'phoneNumber', 'subscriberId']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The compare-and-set: two copies of one inbound message
// ─────────────────────────────────────────────────────────────────────────────

describe('a lost concurrent race reports already_in_state, on EVERY transition', () => {
  // Every transition is read-then-write, and between those two steps another copy of the same
  // inbound webhook can do the same thing. Before `expectedStatus`, the UPDATE was
  // `WHERE id = $1` with no predicate on what was read, so BOTH passes wrote and BOTH reported
  // `applied` — and `applied` is what app/api/sms/inbound/route.ts keys the welcome text off.
  //
  // NOT JOIN-ONLY, which is why this covers all three: they share `runTransition` and one applier.
  // STOP and START are silent today only because nothing reacts to their `applied` outcome; the
  // race is live on the shared path regardless.
  const CASES = [
    { name: 'JOIN vs JOIN', fn: confirmSubscriber, from: 'pending' as const },
    { name: 'STOP vs STOP', fn: mirrorCarrierStop, from: 'active' as const },
    { name: 'START vs START', fn: mirrorCarrierStart, from: 'stopped' as const },
  ];

  it('the WINNER reports applied and the LOSER does not', async () => {
    for (const { name, fn, from } of CASES) {
      // Winner: the row was still in the state it read, so the UPDATE matched.
      const winner = recorder('applied');
      const won = await fn(PHONE, {
        dryRun: false,
        findByPhone: finds(row(from)),
        applyChange: winner.applyChange,
      });
      expect(won.outcome, `${name} winner`).toBe('applied');

      // Loser: same read, same decision — but by the time it wrote, the row had moved.
      const loser = recorder('no_match');
      const lost = await fn(PHONE, {
        dryRun: false,
        findByPhone: finds(row(from)),
        applyChange: loser.applyChange,
      });
      expect(lost.outcome, `${name} loser`).toBe('already_in_state');
      // It still ATTEMPTED the write — losing is decided by the database, not predicted.
      expect(loser.writes, `${name} attempted`).toHaveLength(1);
      // And it reports no change, like every other non-applied outcome: it wrote nothing.
      expect(lost.change, `${name} change`).toBeNull();
      expect(lost.subscriberId, `${name} id`).toBe('sub-1');
    }
  });

  it('carries the status it READ as the predicate, on every transition', async () => {
    // The value the UPDATE compares against. Taken from the row rather than from a per-decision
    // list, so it cannot drift from the decision that produced it.
    for (const { name, fn, from } of CASES) {
      const rec = recorder();
      await fn(PHONE, { dryRun: false, findByPhone: finds(row(from)), applyChange: rec.applyChange });
      expect(rec.writes[0].expectedStatus, name).toBe(from);
      // And it is never the status being written — that would make the predicate always fail.
      expect(rec.writes[0].expectedStatus, name).not.toBe(rec.writes[0].status);
    }
  });

  it('a lost race is NOT an error, and never reports one', async () => {
    // The intended end state has been reached; it just was not us who reached it. Reporting
    // `error` would make a webhook retry look like a failure and invite a third attempt.
    const rec = recorder('no_match');
    const result = await confirmSubscriber(PHONE, {
      dryRun: false,
      findByPhone: finds(row('pending')),
      applyChange: rec.applyChange,
    });
    expect(result.outcome).toBe('already_in_state');
    expect(result.error).toBeUndefined();
  });

  it('and the inbound route sends no welcome for it', async () => {
    // The whole point. `already_in_state` is not `applied`, so the guard in the inbound route
    // does not fire — which is what stops the second copy of one JOIN sending a second welcome.
    const rec = recorder('no_match');
    const result = await confirmSubscriber(PHONE, {
      dryRun: false,
      findByPhone: finds(row('pending')),
      applyChange: rec.applyChange,
    });
    expect(shouldSendWelcome(result)).toBe(false);
  });
});
