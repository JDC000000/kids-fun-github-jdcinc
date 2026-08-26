// tests/sms/consent_transitions.test.ts — the four inbound state transitions.
//
// The database is injected, so every row state is reachable without one: `findByPhone` hands the
// decision a row (or null), `applyChange` records what would have been written. The DECISIONS are
// pure and are also tested directly, because they are the part that must be right — they are the
// documented WHERE clauses expressed as functions.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

/** Records every write the transition attempted. */
function recorder() {
  const writes: ConsentChange[] = [];
  return {
    writes,
    applyChange: async (change: ConsentChange) => {
      writes.push(change);
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
