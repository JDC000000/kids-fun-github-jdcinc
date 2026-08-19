// One rule, two layers, pinned against each other across all sixteen statuses.
//
// `lib/search/filters/status.ts#CONFIRMED_SECTION_STATUSES` is the DOMAIN's answer to "may a
// surface with no room for a caveat present this as an answer?" — used by the front door's three
// things block. `app/preview/_data/format.ts#statusMeta(...).section` is the RENDER layer's
// answer to the same question, and it has been the authority since D7/BR-12.
//
// They are two statements because they cannot be one: `statusMeta` returns labels, copy, icons
// and tones, and `lib/` does not import `app/`. That is a drift risk taken deliberately, and this
// file is the bound on it — a new `status_state`, or a change of mind about (say) whether
// `waitlist` is actionable, fails here naming the exact state rather than quietly letting the
// front door and the card disagree about what "confirmed" means.
//
// It is also a real vacuity check on the front-door gate: if `statusMeta` ever widened its
// confirmed section to everything, the parity assertion below would still pass — so the count is
// asserted too, and the two states are named.

import { describe, expect, it } from 'vitest';
import { STATUS_CLASS, CONFIRMED_SECTION_STATUSES, isConfirmedSection } from '@/lib/search/filters/status';
import type { StatusState } from '@/lib/search/types';
import { statusMeta } from '@/app/preview/_data/format';

const ALL_STATUSES = Object.keys(STATUS_CLASS) as StatusState[];

describe('the domain and the card agree on which statuses are "confirmed"', () => {
  it('matches statusMeta’s section for every one of the sixteen states', () => {
    for (const state of ALL_STATUSES) {
      expect({ state, confirmed: isConfirmedSection({ statusState: state }) }).toEqual({
        state,
        confirmed: statusMeta(state).section === 'confirmed',
      });
    }
  });

  it('is exactly the two verified-and-actionable states — not "most of them"', () => {
    expect([...CONFIRMED_SECTION_STATUSES].sort()).toEqual(['bookable_open', 'confirmed']);
    expect(ALL_STATUSES).toHaveLength(16);
  });

  it('is strictly narrower than the primary result class, which is the whole reason it exists', () => {
    // `stale`, `full`, `waitlist`, `postponed`, `not_yet_bookable`, `schedule_not_published`,
    // `inferred_recurring` and `seasonal_active` are all primary — they belong in a LIST, beside
    // their own status stamp. None of them may be one of three bare cards on the front door.
    const primaryButNotConfirmed = ALL_STATUSES.filter(
      (s) => STATUS_CLASS[s] === 'primary' && !isConfirmedSection({ statusState: s }),
    );
    expect(primaryButNotConfirmed).toContain('stale');
    expect(primaryButNotConfirmed).toContain('postponed');
    expect(primaryButNotConfirmed).toContain('full');
    expect(primaryButNotConfirmed.length).toBeGreaterThan(0);
  });
});
