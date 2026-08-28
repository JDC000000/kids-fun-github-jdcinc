// tests/sms/preferences.test.ts — the no-login preferences / hub page (PRD §2.4).
//
// The database is injected, so every subscriber state is reachable without one. The store below
// holds SEVERAL subscribers on purpose: the single most important property of this page is that a
// token can only ever reach the one row it belongs to, and a store with one row cannot prove that.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hubPickLinks,
  childAgesFrom,
  decideDelete,
  decideSave,
  decideWebUnsubscribe,
  performPreferencesAction,
  resolvePreferences,
  type LastWeek,
  type PreferencesDeps,
  type PreferencesRow,
} from '@/lib/sms/preferences';
import type { ConsentStatus } from '@/lib/sms/consent-transitions';
import { hubClickPath } from '@/lib/sms/click-through';
import { encodeShortLink } from '@/lib/sms/short-link';
import type { ProfileFields } from '@/lib/sms/signup-validate';

const NOW = new Date('2026-08-28T23:00:00Z'); // Friday, local year 2026

/** Tokens are long random strings in production; these are long enough to pass the shape gate. */
const ALICE_TOKEN = 'alice-token-0123456789abcdef';
const BOB_TOKEN = 'bob-token-0123456789abcdefgh';

function row(over: Partial<PreferencesRow> = {}): PreferencesRow {
  return {
    id: 'sub-alice',
    status: 'active',
    stoppedAt: null,
    postalCode: 'V5L 1A1',
    birthYears: [2021, 2018],
    categoryInterests: ['public_swim'],
    consecutiveEmptyWeeks: 0,
    // The subscriber half of a click-through token, so the hub's pick links can be minted.
    shortRef: 7,
    ...over,
  };
}

const ALICE = row();
const BOB = row({
  id: 'sub-bob',
  postalCode: 'V7M 2K4',
  birthYears: [2015],
  categoryInterests: ['skate'],
});

/** A store keyed by token — the shape the real unique-index lookup has. */
function store(entries: Record<string, PreferencesRow>, lastWeek?: LastWeek) {
  const writes: Array<{ change: unknown }> = [];
  const deps: PreferencesDeps = {
    findByToken: async (token) => entries[token] ?? null,
    findLastWeek: async () => lastWeek ?? { kind: 'none', picks: [], sentAt: null },
    applyChange: async (change) => {
      writes.push({ change });
    },
  };
  return { deps, writes };
}

const BOTH = { [ALICE_TOKEN]: ALICE, [BOB_TOKEN]: BOB };

const FIELDS: ProfileFields = {
  postalCode: 'V6B 1A1',
  regionId: 'van',
  birthYears: [2022],
  categoryInterests: ['storytime'],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ISOLATION PROPERTY — the one that matters most
// ─────────────────────────────────────────────────────────────────────────────

describe('no token can ever reach another subscriber', () => {
  it('resolves each token to its OWN row and nothing else', async () => {
    const { deps } = store(BOTH);
    const alice = await resolvePreferences(ALICE_TOKEN, NOW, deps);
    const bob = await resolvePreferences(BOB_TOKEN, NOW, deps);

    expect(alice.outcome).toBe('found');
    expect(bob.outcome).toBe('found');
    if (alice.outcome !== 'found' || bob.outcome !== 'found') return;
    expect(alice.subscriberId).toBe('sub-alice');
    expect(bob.subscriberId).toBe('sub-bob');
    expect(alice.view.postalCode).toBe('V5L 1A1');
    expect(bob.view.postalCode).toBe('V7M 2K4');
  });

  it('a WRONG-BUT-WELL-SHAPED token reaches NOBODY — not the nearest row', async () => {
    // The lookup is exact-match on a unique column, so a near miss resolves to nothing. This is a
    // property of the query rather than of care, and it is what makes the page safe to expose.
    const { deps } = store(BOTH);
    const nearMisses = [
      `${ALICE_TOKEN}x`, // one character longer
      ALICE_TOKEN.slice(0, -1) + 'z', // last character changed
      ALICE_TOKEN.toUpperCase(), // case flipped
      ALICE_TOKEN.replace('-', '_'), // one separator changed
      `${ALICE_TOKEN.slice(0, -1)} `, // trailing space, as a messaging app might leave
    ];
    for (const token of nearMisses) {
      const result = await resolvePreferences(token, NOW, deps);
      expect(result.outcome, token).toBe('not_found');
    }
  });

  it('a wrong token cannot MUTATE another subscriber either', async () => {
    const { deps, writes } = store(BOTH);
    for (const action of ['save', 'unsubscribe', 'delete'] as const) {
      const result = await performPreferencesAction(
        { token: `${ALICE_TOKEN}x`, action, body: { postal: 'V6B 1A1', childAges: [4] }, now: NOW },
        deps
      );
      expect(result.outcome, action).toBe('not_found');
    }
    expect(writes).toEqual([]);
  });

  it('every mutation is keyed on the id the LOOKUP returned, never on anything supplied', async () => {
    // A body field claiming to be someone else's id must be inert. The change is built from the
    // resolved row, so there is nothing for a caller to influence.
    const { deps, writes } = store(BOTH);
    await performPreferencesAction(
      {
        token: ALICE_TOKEN,
        action: 'unsubscribe',
        body: { subscriberId: 'sub-bob', id: 'sub-bob' },
        now: NOW,
      },
      deps
    );
    expect(writes).toHaveLength(1);
    expect((writes[0].change as { subscriberId: string }).subscriberId).toBe('sub-alice');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering state
// ─────────────────────────────────────────────────────────────────────────────

describe('what the page renders', () => {
  it('recomputes ages from stored birth years, so the page matches what the picker used', async () => {
    const { deps } = store(BOTH);
    const result = await resolvePreferences(ALICE_TOKEN, NOW, deps);
    if (result.outcome !== 'found') throw new Error('expected found');
    expect(result.view.childAges).toEqual([5, 8]); // 2026 − 2021, 2026 − 2018
    expect(childAgesFrom(null, NOW)).toEqual([]);
  });

  it('NEVER exposes a phone number or an internal id in the view', async () => {
    // The one field a leaked link would turn into a contactable identity, and the page has no
    // need of it. The subscriberId sits beside the view, not inside it, so nothing rendered
    // carries it either.
    const { deps } = store(BOTH);
    const result = await resolvePreferences(ALICE_TOKEN, NOW, deps);
    if (result.outcome !== 'found') throw new Error('expected found');
    expect(Object.keys(result.view).sort()).toEqual([
      'categoryInterests',
      'childAges',
      'consecutiveEmptyWeeks',
      'lastWeek',
      'postalCode',
      'purged',
      'status',
    ]);
    expect(JSON.stringify(result.view)).not.toContain('sub-alice');
  });

  it('renders each lifecycle state', async () => {
    for (const status of ['active', 'paused', 'pending', 'stopped'] as ConsentStatus[]) {
      const { deps } = store({ [ALICE_TOKEN]: row({ status }) });
      const result = await resolvePreferences(ALICE_TOKEN, NOW, deps);
      if (result.outcome !== 'found') throw new Error('expected found');
      expect(result.view.status).toBe(status);
      expect(result.view.purged).toBe(false);
    }
  });

  it('reports a purged row honestly rather than as a dead link', async () => {
    // The 30-day purge NULLs the personal columns but keeps the row and its token. Someone who
    // kept the link deserves "your details are gone", not a broken page.
    const { deps } = store({
      [ALICE_TOKEN]: row({ status: 'stopped', postalCode: null, birthYears: null, categoryInterests: null }),
    });
    const result = await resolvePreferences(ALICE_TOKEN, NOW, deps);
    if (result.outcome !== 'found') throw new Error('expected found');
    expect(result.view.purged).toBe(true);
    expect(result.view.childAges).toEqual([]);
  });

  it('shows last week, including the empty and paused states', async () => {
    for (const kind of ['weekly', 'empty_week', 'pause_notice', 'none'] as const) {
      const { deps } = store(BOTH, { kind, picks: kind === 'weekly' ? [{ occurrenceId: 'o1', rank: 1, occurrenceShortRef: 42 }] : [], sentAt: NOW });
      const result = await resolvePreferences(ALICE_TOKEN, NOW, deps);
      if (result.outcome !== 'found') throw new Error('expected found');
      expect(result.view.lastWeek.kind).toBe(kind);
    }
  });

  it('still renders when the last-week lookup fails — the CASL controls must survive it', async () => {
    // The picks panel is a nicety; the unsubscribe control is not.
    const { deps } = store(BOTH);
    const result = await resolvePreferences(ALICE_TOKEN, NOW, {
      ...deps,
      findLastWeek: async () => {
        throw new Error('connection terminated');
      },
    });
    expect(result.outcome).toBe('found');
  });

  it('reports a failed lookup as not_found rather than as an error', async () => {
    // The difference between "no such token" and "the database is down" is information a prober
    // would like and a parent cannot use.
    const result = await resolvePreferences(ALICE_TOKEN, NOW, {
      findByToken: async () => {
        throw new Error('connection terminated');
      },
    });
    expect(result.outcome).toBe('not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Saving
// ─────────────────────────────────────────────────────────────────────────────

describe('saving (PRD §2.4)', () => {
  it('resets the empty-week counter to 0', async () => {
    const { deps, writes } = store({ [ALICE_TOKEN]: row({ consecutiveEmptyWeeks: 2 }) });
    const result = await performPreferencesAction(
      { token: ALICE_TOKEN, action: 'save', body: { postal: 'V6B 1A1', childAges: [4], interests: [] }, now: NOW },
      deps
    );
    expect(result.outcome).toBe('applied');
    expect(writes).toHaveLength(1);
    expect(writes[0].change).toMatchObject({ kind: 'save', consecutiveEmptyWeeks: 0 });
  });

  it('UN-PAUSES a paused subscriber — the only way back without re-signing up', async () => {
    const decision = decideSave(row({ status: 'paused', consecutiveEmptyWeeks: 3 }), FIELDS);
    expect(decision.outcome).toBe('applied');
    expect(decision.change).toMatchObject({ status: 'active', consecutiveEmptyWeeks: 0 });
  });

  it('does NOT resurrect a STOPPED subscriber — that would be re-subscribing them', async () => {
    // The CASL violation this whole design exists to avoid: they withdrew consent, and opening an
    // old link and hitting Save must not undo that.
    const { deps, writes } = store({ [ALICE_TOKEN]: row({ status: 'stopped', stoppedAt: NOW }) });
    const result = await performPreferencesAction(
      { token: ALICE_TOKEN, action: 'save', body: { postal: 'V6B 1A1', childAges: [4] }, now: NOW },
      deps
    );
    expect(result.outcome).toBe('not_permitted');
    expect(writes).toEqual([]);
  });

  it('does NOT activate a PENDING subscriber — that would bypass the double opt-in', async () => {
    // Same shape as round 5's START-on-a-pending-row finding. Their edits are kept; the status is
    // left alone and they still have to reply JOIN.
    const decision = decideSave(row({ status: 'pending' }), FIELDS);
    expect(decision.outcome).toBe('applied');
    expect(decision.change).toMatchObject({ kind: 'save', status: null });
  });

  it('validates with the SAME parser the signup form uses', async () => {
    const { deps, writes } = store(BOTH);
    // Out of coverage — rejected on edit exactly as it is at signup.
    const surrey = await performPreferencesAction(
      { token: ALICE_TOKEN, action: 'save', body: { postal: 'V3S 1A1', childAges: [4] }, now: NOW },
      deps
    );
    expect(surrey.outcome).toBe('invalid');
    expect(surrey.field).toBe('postal');

    // 19 is not a child here either.
    const tooOld = await performPreferencesAction(
      { token: ALICE_TOKEN, action: 'save', body: { postal: 'V6B 1A1', childAges: [19] }, now: NOW },
      deps
    );
    expect(tooOld.outcome).toBe('invalid');
    expect(tooOld.field).toBe('children');

    expect(writes).toEqual([]);
  });

  it('converts the entered ages back to birth years, not ages', async () => {
    const { deps, writes } = store(BOTH);
    await performPreferencesAction(
      { token: ALICE_TOKEN, action: 'save', body: { postal: 'V6B 1A1', childAges: [4, 7] }, now: NOW },
      deps
    );
    expect(writes[0].change).toMatchObject({ birthYears: [2022, 2019] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unsubscribe and delete
// ─────────────────────────────────────────────────────────────────────────────

describe('unsubscribe', () => {
  it('reaches the SAME transition a STOP text does', async () => {
    // decideWebUnsubscribe delegates to decideStop — the identical pure decision the carrier
    // mirror uses — because the target state is identical in every column.
    const decision = decideWebUnsubscribe(row({ status: 'active' }));
    expect(decision.outcome).toBe('applied');
    expect(decision.change).toEqual({
      kind: 'unsubscribe',
      subscriberId: 'sub-alice',
      stoppedAt: 'set',
    });
  });

  it('does not re-stamp stopped_at on an already-stopped subscriber', async () => {
    // Re-stamping would push the 30-day purge deadline out. Same rule the carrier mirror follows.
    const { deps, writes } = store({ [ALICE_TOKEN]: row({ status: 'stopped', stoppedAt: NOW }) });
    const result = await performPreferencesAction(
      { token: ALICE_TOKEN, action: 'unsubscribe', now: NOW },
      deps
    );
    expect(result.outcome).toBe('already_in_state');
    expect(writes).toEqual([]);
  });

  it('works from any live state, including paused and pending', async () => {
    for (const status of ['active', 'paused', 'pending'] as ConsentStatus[]) {
      const { deps, writes } = store({ [ALICE_TOKEN]: row({ status }) });
      const result = await performPreferencesAction(
        { token: ALICE_TOKEN, action: 'unsubscribe', now: NOW },
        deps
      );
      expect(result.outcome, status).toBe('applied');
      expect(writes, status).toHaveLength(1);
    }
  });
});

describe('delete my data', () => {
  it('is a DIFFERENT change from unsubscribe, and erases immediately', async () => {
    // The reading of §1.3 recorded in decideDelete: the 30-day grace guards against an ACCIDENT,
    // and an explicit confirmed request is definitionally not one. The accident guard lives in
    // the UI's two-step confirmation instead.
    const { deps, writes } = store(BOTH);
    const result = await performPreferencesAction(
      { token: ALICE_TOKEN, action: 'delete', now: NOW },
      deps
    );
    expect(result.outcome).toBe('applied');
    expect(writes[0].change).toEqual({ kind: 'delete', subscriberId: 'sub-alice' });
  });

  it('is idempotent on an already-purged row', async () => {
    const purged = row({ status: 'stopped', postalCode: null, birthYears: null, categoryInterests: null });
    expect(decideDelete(purged).outcome).toBe('already_in_state');
    expect(decideDelete(purged).change).toBeNull();
  });

  it('still deletes for a stopped-but-not-yet-purged subscriber', async () => {
    // They unsubscribed last week and have now decided they want it gone rather than waiting out
    // the 30 days. That is a live request, not a no-op.
    const decision = decideDelete(row({ status: 'stopped', stoppedAt: NOW }));
    expect(decision.outcome).toBe('applied');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure handling
// ─────────────────────────────────────────────────────────────────────────────

describe('failures never leak and never half-apply', () => {
  it('classifies a failed write without naming the subscriber', async () => {
    const { deps } = store(BOTH);
    const result = await performPreferencesAction(
      { token: ALICE_TOKEN, action: 'unsubscribe', now: NOW },
      {
        ...deps,
        applyChange: async () => {
          throw new Error('deadlock detected on relation sms_consent for id sub-alice');
        },
      }
    );
    expect(result.outcome).toBe('error');
    expect(result.error).toBe('could not save that just now');
    expect(result.error).not.toContain('sub-alice');
  });

  it('rejects a token of implausible shape before touching the database', async () => {
    const findByToken = vi.fn(async () => ALICE);
    for (const token of [null, undefined, '', 'short', 'x'.repeat(300)]) {
      const result = await performPreferencesAction(
        { token, action: 'unsubscribe', now: NOW },
        { findByToken }
      );
      expect(result.outcome).toBe('not_found');
    }
    expect(findByToken).not.toHaveBeenCalled();
  });

  it('the default seams are inert — an unwired call finds nothing and writes nothing', async () => {
    expect((await resolvePreferences(ALICE_TOKEN, NOW)).outcome).toBe('not_found');
    for (const action of ['save', 'unsubscribe', 'delete'] as const) {
      const result = await performPreferencesAction({ token: ALICE_TOKEN, action, now: NOW });
      expect(result.outcome, action).toBe('not_found');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The hub's pick links — PRD §2.4 linking through §2.3's instrumentation
// ─────────────────────────────────────────────────────────────────────────────

describe("last week's pick links", () => {
  const PICKS = [
    { occurrenceId: 'occ-1', rank: 1, occurrenceShortRef: 5601 },
    { occurrenceId: 'occ-2', rank: 2, occurrenceShortRef: 5602 },
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function withSecret() {
    vi.stubEnv('SMS_SHORT_LINK_SECRET', 'test-short-link-secret');
  }

  it('goes through /s/{token}?via=hub, NOT straight to /activity', async () => {
    // The whole point. While these linked to /activity directly, a hub tap never reached the
    // click-through route, so `sms_click_event.link_origin = 'hub'` could not be written and PRD
    // §6's direct-vs-hub split had an empty bucket by construction.
    withSecret();
    const { deps } = store(BOTH, { kind: 'weekly', picks: PICKS, sentAt: NOW });
    const result = await resolvePreferences(ALICE_TOKEN, NOW, deps);
    if (result.outcome !== 'found') throw new Error('expected found');

    for (const pick of result.view.lastWeek.picks) {
      expect(pick.href).toMatch(/^\/s\/[0-9A-Za-z]{13}\?via=hub$/);
      expect(pick.attributed).toBe(true);
      expect(pick.href).not.toContain('/activity/');
    }
  });

  it('mints the SAME token the weekly send would for that pair', async () => {
    // Deterministic per (occurrence, subscriber) — so a tap from the hub and a tap from the text
    // resolve to the same activity for the same person, and only `link_origin` differs.
    withSecret();
    const { deps } = store(BOTH, { kind: 'weekly', picks: [PICKS[0]], sentAt: NOW });
    const result = await resolvePreferences(ALICE_TOKEN, NOW, deps);
    if (result.outcome !== 'found') throw new Error('expected found');
    expect(result.view.lastWeek.picks[0].href).toBe(hubClickPath(encodeShortLink(5601, 7)));
  });

  it('carries NO internal reference into the view — only the finished href', async () => {
    // PreferencesView's stated property. `short_ref` goes in, an href comes out.
    withSecret();
    const { deps } = store(BOTH, { kind: 'weekly', picks: PICKS, sentAt: NOW });
    const result = await resolvePreferences(ALICE_TOKEN, NOW, deps);
    if (result.outcome !== 'found') throw new Error('expected found');
    const serialized = JSON.stringify(result.view);
    expect(serialized).not.toContain('shortRef');
    expect(serialized).not.toContain('5601');
    expect(Object.keys(result.view.lastWeek.picks[0]).sort()).toEqual([
      'attributed',
      'href',
      'occurrenceId',
      'rank',
    ]);
  });

  it('degrades to the plain activity link rather than to NO link', async () => {
    // Three ways a token cannot be minted, none of which may cost a parent the pick.
    withSecret();
    const cases: Array<[string, Parameters<typeof hubPickLinks>]> = [
      ['subscriber has no short_ref', [null, PICKS]],
      ['occurrence was archived since the send', [7, [{ ...PICKS[0], occurrenceShortRef: null }]]],
    ];
    for (const [name, args] of cases) {
      const [link] = hubPickLinks(...args);
      expect(link.href, name).toBe('/activity/occ-1');
      expect(link.attributed, name).toBe(false);
    }

    // And the third: no signing secret. encodeShortLink THROWS rather than truncating (a
    // truncated ref would point at the wrong activity), so the fallback is the honest link.
    vi.unstubAllEnvs();
    const [unsigned] = hubPickLinks(7, PICKS);
    expect(unsigned.href).toBe('/activity/occ-1');
    expect(unsigned.attributed).toBe(false);
  });

  it('reports the degradation instead of hiding it', () => {
    // An unattributed hub link is a click PRD §6 will never see. A panel silently full of them
    // reads as a flat metric months later, not as a bug.
    withSecret();
    expect(hubPickLinks(7, PICKS).every((p) => p.attributed)).toBe(true);
    expect(hubPickLinks(null, PICKS).some((p) => p.attributed)).toBe(false);
  });

  it('keeps an archived pick IN the panel — the snapshot records what we SENT', async () => {
    // picks_snapshot is the record of the message that went out. A pick cancelled since must
    // still be listed; it just links unattributed, and (see click_through.test.tsx) a tap on an
    // attributed link to a gone occurrence now reaches the "activity unavailable" interstitial
    // instead of the detail page's bare notFound().
    withSecret();
    const { deps } = store(BOTH, {
      kind: 'weekly',
      picks: [PICKS[0], { occurrenceId: 'occ-gone', rank: 2, occurrenceShortRef: null }],
      sentAt: NOW,
    });
    const result = await resolvePreferences(ALICE_TOKEN, NOW, deps);
    if (result.outcome !== 'found') throw new Error('expected found');
    expect(result.view.lastWeek.picks).toHaveLength(2);
    expect(result.view.lastWeek.picks[1].attributed).toBe(false);
  });
});
