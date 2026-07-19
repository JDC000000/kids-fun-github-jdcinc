import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button, Chip as UIChip, Input } from '@/components/ui';
import type { AgeBandKey } from '@/lib/search/types';
import {
  AGE_OPTIONS,
  CLEARED_FILTERS,
  COST_MAX_OPTIONS,
  RADIUS_OPTIONS,
  REGION_CHIPS,
  TIME_OF_DAY_OPTIONS,
  WHEN_OPTIONS,
  dateRangeFormFields,
  hasActiveFilters,
  hasDateRange,
  hasNearMeCoords,
  hrefFor,
  toggleAge,
  toggleRegion,
  type SearchState,
} from '../_lib/params';
import { NearMeButton } from './NearMeButton';

/** The signed-in user's saved-location area, resolved server-side. Null → not offered. */
export interface SavedLocationInfo {
  /** Area label for the chip, e.g. "North Vancouver" (from the saved postal's FSA). */
  areaLabel: string;
}

// The filter rails under the search bar (Blueprint Screen 2 + Screen 5 groups ①②⑤⑥ and
// the "Where" control). Every control is a plain <Link> that rewrites the URL, so filters
// are shareable, back-button-safe, and work with JavaScript disabled — the same pattern as
// the existing sort/cost chips. The one exception is "Near me", which needs the browser's
// geolocation API and so is a small client island (NearMeButton); its result still lands in
// the URL (?lat&lng) so a shared near-me link resolves without re-prompting.
//
// Chips: selected state is fill AND a checkmark (never colour alone — WCAG, D10). Because
// every chip here is a real <a> (implicit role="link"), selection is conveyed uniformly with
// aria-current="true" — the only selected-state attribute ARIA permits on a link. aria-pressed
// is a button-only toggle state; carrying it on an anchor is a WCAG 4.1.2 (aria-allowed-attr)
// violation, which is exactly what the Round 18 a11y-remediation fixed. The multi-select vs
// radio-like nuance is now carried by the group labels + the multi/single toggle behaviour of
// the links, not by a link-invalid ARIA state. Rails scroll-snap horizontally for one-thumb use.

// A URL-driven filter chip: a real <Link> (shareable, back-button-safe, works with JS
// off) on the shared Chip primitive. Selection is fill + ✓ (owned by the primitive) plus
// aria-current="true" — valid on the anchor's implicit role="link" for BOTH the radio-like
// groups (When, Time of day, Max price, Radius) and the multi-select toggles (Ages, Areas,
// quick filters). aria-pressed is deliberately NOT used: it is button-only and invalid on a
// link (axe aria-allowed-attr / WCAG 4.1.2 Name, Role, Value).
function Chip({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <UIChip as={Link} href={href} selected={active} aria-current={active ? 'true' : undefined}>
      {children}
    </UIChip>
  );
}

function Group({ label, children, id }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="kf-fgroup" role="group" aria-labelledby={id}>
      <span className="kf-fgroup__label" id={id}>
        {label}
      </span>
      <div className="kf-fgroup__rail">{children}</div>
    </div>
  );
}

/**
 * Custom date-range control (T26 / G-T26-1, FR-04). A native GET <form> — two `<input
 * type="date">` (From / To) + an Apply submit — so the range is URL-driven, shareable,
 * back-button-safe and works with JavaScript disabled, exactly like the rest of the rail.
 * It is intentionally NOT a link-chip: a date range is not a finite chip set, and native
 * date fields carry no aria-pressed/aria-current (so it can't reintroduce the Round 18
 * aria-allowed-attr regression). Hidden fields carry the rest of the search (q + every other
 * filter, minus from/to/when) so applying dates never drops the current search; submitting a
 * range clears the WHEN quick-pick (they're mutually exclusive). The Apply button is the
 * shared secondary Button — Leaf stays reserved for the one primary Search CTA (Workbook §7).
 */
function DateRangeControl({ state }: { state: SearchState }) {
  const active = hasDateRange(state);
  return (
    <div className="kf-fgroup" role="group" aria-labelledby="kf-fg-daterange">
      <span className="kf-fgroup__label" id="kf-fg-daterange">
        Custom dates
      </span>
      <form className="kf-daterange" action="/search" method="get">
        {dateRangeFormFields(state).map((field) => (
          <input key={field.name} type="hidden" name={field.name} value={field.value} />
        ))}
        <div className="kf-daterange__field">
          <label className="kf-daterange__lbl" htmlFor="kf-date-from">
            From
          </label>
          <Input
            id="kf-date-from"
            type="date"
            name="from"
            defaultValue={state.dateFrom ?? ''}
            className="kf-daterange__input"
          />
        </div>
        <div className="kf-daterange__field">
          <label className="kf-daterange__lbl" htmlFor="kf-date-to">
            To
          </label>
          <Input
            id="kf-date-to"
            type="date"
            name="to"
            defaultValue={state.dateTo ?? ''}
            className="kf-daterange__input"
          />
        </div>
        <Button variant="secondary" size="sm" type="submit" className="kf-daterange__apply">
          Apply dates
        </Button>
      </form>
      {active && (
        <Link className="kf-daterange__clear" href={hrefFor(state, { dateFrom: null, dateTo: null })}>
          Clear dates
        </Link>
      )}
    </div>
  );
}

export function FilterRail({
  state,
  savedLocation,
}: {
  state: SearchState;
  savedLocation?: SavedLocationInfo | null;
}) {
  const savedActive = state.useSavedLocation && !!savedLocation;
  // Radius only matters once there's a REAL origin — browser coords, or a saved location
  // we could actually resolve (not merely a ?home=1 flag with no signed-in profile behind it).
  const originActive = hasNearMeCoords(state) || savedActive;

  return (
    <div className="kf-filters" aria-label="Filters">
      {/* When — date quick-pick (radio-like: one at a time). Picking one clears any custom
          date range (from/to) — the quick-pick and the range are mutually-exclusive date intent. */}
      <Group label="When" id="kf-fg-when">
        {WHEN_OPTIONS.map((opt) => (
          <Chip
            key={opt.key}
            href={hrefFor(state, { when: opt.key, dateFrom: null, dateTo: null })}
            active={state.when === opt.key}
          >
            {opt.label}
          </Chip>
        ))}
      </Group>

      {/* Custom dates — a start→end RANGE the quick-picks can't express (T26 / FR-04). A plain
          GET <form> of two native <input type="date"> + a submit, so it is URL-driven, shareable,
          works with JavaScript off, and is fully keyboard/AT-accessible with ZERO custom ARIA —
          deliberately NOT a link-chip (aria-pressed/aria-current don't apply to native form
          fields; a range isn't a finite chip set). When a range is active the page filters to it
          AND groups the results by day. */}
      <DateRangeControl state={state} />

      {/* Time of day — day-part quick-pick (radio-like: one at a time; maps to DayPart). */}
      <Group label="Time of day" id="kf-fg-time">
        {TIME_OF_DAY_OPTIONS.map((opt) => (
          <Chip key={opt.key} href={hrefFor(state, { timeOfDay: opt.key })} active={state.timeOfDay === opt.key}>
            {opt.label}
          </Chip>
        ))}
      </Group>

      {/* Ages — multi-select ("Pick every child — we'll match either age"). */}
      <Group label="Ages" id="kf-fg-ages">
        {AGE_OPTIONS.map((opt) => {
          const active = state.ages.includes(opt.key);
          return (
            <Chip
              key={opt.key}
              href={hrefFor(state, { ages: toggleAge(state, opt.key as AgeBandKey) })}
              active={active}
            >
              {opt.label}
            </Chip>
          );
        })}
      </Group>

      {/* Areas — additive region hierarchy (multi-select union). */}
      <Group label="Areas" id="kf-fg-areas">
        {REGION_CHIPS.map((r) => {
          const active = state.regions.includes(r.id);
          return (
            <Chip key={r.id} href={hrefFor(state, { regions: toggleRegion(state, r.id) })} active={active}>
              {r.label}
            </Chip>
          );
        })}
      </Group>

      {/* Quick filters — status / suitability / cost chips (multi-select toggles). */}
      <Group label="Quick filters" id="kf-fg-quick">
        <Chip href={hrefFor(state, { bookableNow: !state.bookableNow })} active={state.bookableNow}>
          Bookable now
        </Chip>
        <Chip href={hrefFor(state, { dropIn: !state.dropIn })} active={state.dropIn}>
          Drop-in
        </Chip>
        <Chip href={hrefFor(state, { rainyDay: !state.rainyDay })} active={state.rainyDay}>
          Rainy-day
        </Chip>
        <Chip href={hrefFor(state, { free: !state.free })} active={state.free}>
          Free
        </Chip>
      </Group>

      {/* Max price — cost ceiling (radio-like: one at a time). Sits alongside the binary
          "Free" quick-filter so "cost range / free" is fully exposed (G-T21-4). */}
      <Group label="Max price" id="kf-fg-cost">
        {COST_MAX_OPTIONS.map((opt) => (
          <Chip key={opt.key} href={hrefFor(state, { costMaxCad: opt.maxCad })} active={state.costMaxCad === opt.maxCad}>
            {opt.label}
          </Chip>
        ))}
      </Group>

      {/* Near me — origin + travel radius (radius shown once an origin is set). Two origins:
          browser geolocation (NearMeButton, anyone) and the signed-in user's saved location
          (a plain Link — no browser permission needed; only rendered when we resolved it). */}
      <Group label="Near me" id="kf-fg-near">
        <NearMeButton state={state} />
        {savedLocation &&
          (savedActive ? (
            <>
              <UIChip as="span" selected aria-current="true">
                Near {savedLocation.areaLabel}
              </UIChip>
              <UIChip
                as={Link}
                href={hrefFor(state, { useSavedLocation: false })}
                aria-label="Clear saved-location search"
              >
                Clear saved location
              </UIChip>
            </>
          ) : (
            <UIChip as={Link} action href={hrefFor(state, { useSavedLocation: true, lat: null, lng: null })}>
              <span aria-hidden="true">🏠</span> Near my saved location
            </UIChip>
          ))}
        {originActive &&
          RADIUS_OPTIONS.map((km) => (
            <Chip key={km} href={hrefFor(state, { radiusKm: km })} active={state.radiusKm === km}>
              {km} km
            </Chip>
          ))}
      </Group>

      {hasActiveFilters(state) && (
        <div className="kf-filters__foot">
          <Link className="kf-filters__clear" href={hrefFor(state, CLEARED_FILTERS)}>
            Clear filters
          </Link>
        </div>
      )}
    </div>
  );
}
