import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AgeBandKey } from '@/lib/search/types';
import {
  AGE_OPTIONS,
  CLEARED_FILTERS,
  RADIUS_OPTIONS,
  REGION_CHIPS,
  WHEN_OPTIONS,
  hasActiveFilters,
  hasOrigin,
  hrefFor,
  toggleAge,
  toggleRegion,
  type SearchState,
} from '../_lib/params';
import { NearMeButton } from './NearMeButton';

// The filter rails under the search bar (Blueprint Screen 2 + Screen 5 groups ①②⑤⑥ and
// the "Where" control). Every control is a plain <Link> that rewrites the URL, so filters
// are shareable, back-button-safe, and work with JavaScript disabled — the same pattern as
// the existing sort/cost chips. The one exception is "Near me", which needs the browser's
// geolocation API and so is a small client island (NearMeButton); its result still lands in
// the URL (?lat&lng) so a shared near-me link resolves without re-prompting.
//
// Chips: selected state is fill AND a checkmark (never colour alone — WCAG, D10). Radio-like
// groups (When, Radius) use aria-current; multi-select toggles (Areas, Ages, quick filters)
// use aria-pressed. Rails scroll-snap horizontally for one-thumb use.

function Chip({ href, active, pressed, children }: { href: string; active: boolean; pressed?: boolean; children: ReactNode }) {
  return (
    <Link
      className="kf-fchip"
      href={href}
      aria-current={pressed === undefined && active ? 'true' : undefined}
      aria-pressed={pressed === undefined ? undefined : active}
    >
      {active && (
        <span className="kf-fchip__check" aria-hidden="true">
          ✓
        </span>
      )}
      {children}
    </Link>
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

export function FilterRail({ state }: { state: SearchState }) {
  const originActive = hasOrigin(state);

  return (
    <div className="kf-filters" aria-label="Filters">
      {/* When — date quick-pick (radio-like: one at a time). */}
      <Group label="When" id="kf-fg-when">
        {WHEN_OPTIONS.map((opt) => (
          <Chip key={opt.key} href={hrefFor(state, { when: opt.key })} active={state.when === opt.key}>
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
              pressed={active}
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
            <Chip key={r.id} href={hrefFor(state, { regions: toggleRegion(state, r.id) })} active={active} pressed={active}>
              {r.label}
            </Chip>
          );
        })}
      </Group>

      {/* Quick filters — status / suitability / cost chips. */}
      <Group label="Quick filters" id="kf-fg-quick">
        <Chip href={hrefFor(state, { bookableNow: !state.bookableNow })} active={state.bookableNow} pressed={state.bookableNow}>
          Bookable now
        </Chip>
        <Chip href={hrefFor(state, { rainyDay: !state.rainyDay })} active={state.rainyDay} pressed={state.rainyDay}>
          Rainy-day
        </Chip>
        <Chip href={hrefFor(state, { free: !state.free })} active={state.free} pressed={state.free}>
          Free
        </Chip>
      </Group>

      {/* Near me — geolocation origin + travel radius (radius shown once an origin is set). */}
      <Group label="Near me" id="kf-fg-near">
        <NearMeButton state={state} />
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
