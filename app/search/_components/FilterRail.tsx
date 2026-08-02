import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button, Chip as UIChip, Input } from '@/components/ui';
import type { AgeBandKey } from '@/lib/search/types';
import { facetCount, type FacetCounts } from '@/lib/search/facets';
import {
  AGE_OPTIONS,
  CLEARED_FILTERS,
  COST_MAX_OPTIONS,
  RADIUS_OPTIONS,
  REGION_CHIPS,
  TIME_OF_DAY_OPTIONS,
  WHEN_OPTIONS,
  dateRangeFormFields,
  hasClearableFilters,
  hasDateRange,
  hasNearMeCoords,
  hrefFor,
  toggleAge,
  toggleRegion,
  type SearchState,
} from '../_lib/params';
import { RAIL_GROUP_ORDER, type RailGroupId, type RailPlan } from '../_lib/rail-groups';
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
//
// ── TWO OPTIONAL EXTENSIONS (Round 31, desktop rail) ────────────────────────────────────
// `facets` and `plan` are both optional and both default to OFF, so a caller that passes
// neither — today's inline rail, and the mobile bottom sheet that wraps it — gets exactly
// the markup it got before: all nine groups, in order, with no counts. The desktop rail
// passes both:
//   • `facets` puts a live result count on each chip (lib/search/facets.ts drop-one counts),
//     so a parent can see that "Morning" leaves 5 and "Evening" leaves 0 before spending a
//     click, and dead ends are visibly dead rather than discovered by trying them;
//   • `plan` splits the groups into an up-front set and a folded "More filters" set
//     (app/search/_lib/rail-groups.ts). This is what stops a persistent sidebar from being
//     the same nine-group wall in a narrower column.
// Folded groups are still RENDERED, inside a native <details> — every chip stays in the DOM
// as a real <Link>, so the deep-link/back-button architecture and JS-off operability are
// untouched, and a filter the parent has already applied is never folded.

/** Where each rail group's counts live in the facet payload (`null` → the group has none). */
const FACET_GROUP_FOR: Record<RailGroupId, string | null> = {
  when: 'when',
  dates: null,
  timeOfDay: 'timeOfDay',
  ages: 'ages',
  areas: 'areas',
  quick: 'quick',
  courses: 'registration',
  costMax: 'costMax',
  nearMe: 'radius',
};

// A URL-driven filter chip: a real <Link> (shareable, back-button-safe, works with JS
// off) on the shared Chip primitive. Selection is fill + ✓ (owned by the primitive) plus
// aria-current="true" — valid on the anchor's implicit role="link" for BOTH the radio-like
// groups (When, Time of day, Max price, Radius) and the multi-select toggles (Ages, Areas,
// quick filters). aria-pressed is deliberately NOT used: it is button-only and invalid on a
// link (axe aria-allowed-attr / WCAG 4.1.2 Name, Role, Value).
//
// `count` is the live facet count, when the caller supplied facets. It is rendered as a
// numeral for sighted parents AND as a phrase for assistive tech — a bare trailing digit
// beside a label is ambiguous read aloud ("Morning 5" could be a time). A zero-count chip
// stays a real link and stays focusable: it is a legitimate destination (it clears back to
// something) and removing it from the tab order for having no results would be a keyboard
// trap of a different kind. It is marked `data-empty` so the CSS can mute it.
function Chip({
  href,
  active,
  count,
  children,
}: {
  href: string;
  active: boolean;
  count?: number | null;
  children: ReactNode;
}) {
  return (
    <UIChip
      as={Link}
      href={href}
      selected={active}
      aria-current={active ? 'true' : undefined}
      {...(count === 0 ? { 'data-empty': 'true' } : {})}
    >
      {children}
      {count != null && (
        <>
          <span className="kf-fchip__n" aria-hidden="true">
            {count}
          </span>
          <span className="kf-visually-hidden">, {count} matching</span>
        </>
      )}
    </UIChip>
  );
}

// A filter group. `optional` appends a quiet, de-emphasized "optional" qualifier to the
// label (Round 30, Jon's hands-on search-UX feedback): it tells a parent the group is safe
// to skip — leaving it untouched applies no filter and shows everything (the confirmed
// default behaviour; see app/search/_lib/params.ts DEFAULT_STATE + intentPhrases). It is the
// unset-is-everything signal for the ONE group that can't use an "Any X" default pill — the
// independent-toggle "Quick filters" group; every other group carries a leading "Any X" chip
// instead (When/Time/Max price/Ages/Areas). The qualifier lives inside the labelledby target
// so the group's accessible name becomes e.g. "Quick filters optional"; the middot separator
// is decorative (aria-hidden) so AT never reads it. Sentence-case + muted tone keeps it a
// quiet aside, not a second shouty micro-label.
function Group({
  label,
  children,
  id,
  optional,
}: {
  label: string;
  id: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="kf-fgroup" role="group" aria-labelledby={id}>
      <span className="kf-fgroup__label" id={id}>
        {label}
        {optional && (
          <span className="kf-fgroup__optional">
            <span className="kf-fgroup__optional-dot" aria-hidden="true">
              ·
            </span>
            optional
          </span>
        )}
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

export interface FilterRailProps {
  state: SearchState;
  savedLocation?: SavedLocationInfo | null;
  /**
   * Live per-value result counts (`/api/search?…&facets=1`). Omit for no counts — the
   * markup is then identical to the pre-count rail.
   */
  facets?: FacetCounts | null;
  /**
   * Which groups sit up front and which fold into "More filters"
   * (app/search/_lib/rail-groups.ts). Omit to render all nine in canonical order.
   */
  plan?: RailPlan | null;
}

export function FilterRail({ state, savedLocation, facets, plan }: FilterRailProps) {
  const savedActive = state.useSavedLocation && !!savedLocation;
  // Radius only matters once there's a REAL origin — browser coords, or a saved location
  // we could actually resolve (not merely a ?home=1 flag with no signed-in profile behind it).
  const originActive = hasNearMeCoords(state) || savedActive;

  /** Facet count for one chip, or undefined when the caller supplied no counts. */
  const countFor = (group: RailGroupId, value: string): number | undefined => {
    if (!facets) return undefined;
    const key = FACET_GROUP_FOR[group];
    if (!key) return undefined;
    return facetCount(facets, key, value) ?? undefined;
  };

  /**
   * Areas is the ONE data-driven group, and it needs its own lookup.
   *
   * Every other group's facet values come from a fixed vocabulary shared with the URL
   * ('today', '5-9', 'free'), so `value === chip id` always holds. Areas values come from the
   * region hierarchy: in fixture mode they happen to be these same chip ids, but in DATABASE
   * mode they are region UUIDs carrying a `label`. An id-only lookup therefore matches
   * nothing in production while passing every local test — the Areas group would render with
   * no counts at all, silently, on the one group a parent most needs numbers on.
   *
   * Matching falls back to the region's real name (REGION_CHIPS[].regionName) rather than the
   * chip's short copy, because the two differ for North/West Vancouver.
   *
   * NOTE the direction of travel: the facet VALUE is never used to build a href. The links
   * below are still built from the chip id, because `region=` is parsed against a
   * fixed five-id vocabulary and a UUID round-tripped through it would be silently dropped.
   */
  const areaCountFor = (chip: { id: string; regionName: string }): number | undefined => {
    if (!facets) return undefined;
    const group = facets.groups.find((g) => g.key === 'areas');
    const match = group?.values.find(
      (v) => v.value === chip.id || v.label?.toLowerCase() === chip.regionName.toLowerCase(),
    );
    return match?.count;
  };

  const groups: Record<RailGroupId, ReactNode> = {
    /* When — date quick-pick (radio-like: one at a time). Picking one clears any custom
       date range (from/to) — the quick-pick and the range are mutually-exclusive date intent. */
    when: (
      <Group label="When" id="kf-fg-when" key="when">
        {WHEN_OPTIONS.map((opt) => (
          <Chip
            key={opt.key}
            href={hrefFor(state, { when: opt.key, dateFrom: null, dateTo: null })}
            active={state.when === opt.key}
            count={countFor('when', opt.key)}
          >
            {opt.label}
          </Chip>
        ))}
      </Group>
    ),

    /* Custom dates — a start→end RANGE the quick-picks can't express (T26 / FR-04). A plain
       GET <form> of two native <input type="date"> + a submit, so it is URL-driven, shareable,
       works with JavaScript off, and is fully keyboard/AT-accessible with ZERO custom ARIA —
       deliberately NOT a link-chip (aria-pressed/aria-current don't apply to native form
       fields; a range isn't a finite chip set). When a range is active the page filters to it
       AND groups the results by day. Carries no facet counts: a range is not a finite chip set. */
    dates: <DateRangeControl state={state} key="dates" />,

    /* Time of day — day-part quick-pick (radio-like: one at a time; maps to DayPart). */
    timeOfDay: (
      <Group label="Time of day" id="kf-fg-time" key="timeOfDay">
        {TIME_OF_DAY_OPTIONS.map((opt) => (
          <Chip
            key={opt.key}
            href={hrefFor(state, { timeOfDay: opt.key })}
            active={state.timeOfDay === opt.key}
            count={countFor('timeOfDay', opt.key)}
          >
            {opt.label}
          </Chip>
        ))}
      </Group>
    ),

    /* Ages — multi-select ("Pick every child — we'll match either age"). Leads with an
       "Any age" default pill (checkmarked when no band is chosen) so an unset group reads as
       "all ages" — the SAME "Any X" default-chip rule the When / Time of day / Max price
       groups use. Tapping it clears every selected band. Leaving it unset composes no age
       phrase, so results span every age (params.ts intentPhrases). */
    ages: (
      <Group label="Ages" id="kf-fg-ages" key="ages">
        <Chip href={hrefFor(state, { ages: [] })} active={state.ages.length === 0} count={countFor('ages', 'any')}>
          Any age
        </Chip>
        {AGE_OPTIONS.map((opt) => {
          const active = state.ages.includes(opt.key);
          return (
            <Chip
              key={opt.key}
              href={hrefFor(state, { ages: toggleAge(state, opt.key as AgeBandKey) })}
              active={active}
              count={countFor('ages', opt.key)}
            >
              {opt.label}
            </Chip>
          );
        })}
      </Group>
    ),

    /* Areas — additive region hierarchy (multi-select union). Leads with an "Any area"
       default pill (checkmarked when no region is chosen) so an unset group reads as
       "everywhere in Metro Vancouver" — matching the "Any X" default-chip rule used by
       When / Time of day / Max price / Ages. Tapping it clears every selected area. */
    areas: (
      <Group label="Areas" id="kf-fg-areas" key="areas">
        <Chip
          href={hrefFor(state, { regions: [] })}
          active={state.regions.length === 0}
          count={countFor('areas', 'any')}
        >
          Any area
        </Chip>
        {REGION_CHIPS.map((r) => {
          const active = state.regions.includes(r.id);
          return (
            <Chip
              key={r.id}
              href={hrefFor(state, { regions: toggleRegion(state, r.id) })}
              active={active}
              count={areaCountFor(r)}
            >
              {r.label}
            </Chip>
          );
        })}
      </Group>
    ),

    /* Quick filters — status / suitability / cost chips (independent, non-exclusive toggles).
       Unlike the other groups it has no single meaningful "Any" default chip (the four facets
       are orthogonal, not mutually exclusive), so it carries the quiet "· optional" label as
       its unset-is-everything signal instead of an "Any X" pill. All four default off → no
       filtering (shows all results). */
    quick: (
      <Group label="Quick filters" id="kf-fg-quick" optional key="quick">
        <Chip
          href={hrefFor(state, { bookableNow: !state.bookableNow })}
          active={state.bookableNow}
          count={countFor('quick', 'bookableNow')}
        >
          Bookable now
        </Chip>
        <Chip href={hrefFor(state, { dropIn: !state.dropIn })} active={state.dropIn} count={countFor('quick', 'dropIn')}>
          Drop-in
        </Chip>
        <Chip
          href={hrefFor(state, { rainyDay: !state.rainyDay })}
          active={state.rainyDay}
          count={countFor('quick', 'rainyDay')}
        >
          Rainy-day
        </Chip>
        <Chip href={hrefFor(state, { free: !state.free })} active={state.free} count={countFor('quick', 'free')}>
          Free
        </Chip>
      </Group>
    ),

    /* Courses — the one control that changes WHAT KIND of thing results contain, so it is its
       own group with its default state spelled out rather than a lone toggle buried in the quick
       filters (those all narrow; this one widens). Registered courses, camps and lesson programmes
       are left out of results unless a parent asks for them: this product answers "what can we do
       today", and a 12-week programme with a registration deadline is a different question. The
       left chip is the default and is checkmarked on a bare /search, so the exclusion is stated on
       the page instead of being invisible. Nothing is unreachable — turning the right chip on
       brings every course back, each card labelled "Registration required".

       Its counts are the one pair in the rail where the RIGHT-hand number is the larger one:
       every other group narrows, this one widens. The gap between the two is exactly how much
       course content this search is holding back, which is also how rail-groups.ts decides
       whether the control is worth showing up front at all (no gap → nothing to opt into). */
    courses: (
      <Group label="Courses" id="kf-fg-courses" key="courses">
        <Chip
          href={hrefFor(state, { includeRegistration: false })}
          active={!state.includeRegistration}
          count={countFor('courses', 'dropInOnly')}
        >
          Drop-in only
        </Chip>
        <Chip
          href={hrefFor(state, { includeRegistration: true })}
          active={state.includeRegistration}
          count={countFor('courses', 'includeRegistration')}
        >
          Include registration courses
        </Chip>
      </Group>
    ),

    /* Max price — cost ceiling (radio-like: one at a time). Sits alongside the binary
       "Free" quick-filter so "cost range / free" is fully exposed (G-T21-4). Already leads
       with an "Any price" default pill (costMaxCad null), so it needs no separate label — the
       "Any X" pill is its unset-is-everything signal, consistent with When/Time/Ages/Areas. */
    costMax: (
      <Group label="Max price" id="kf-fg-cost" key="costMax">

        {COST_MAX_OPTIONS.map((opt) => (
          <Chip
            key={opt.key}
            href={hrefFor(state, { costMaxCad: opt.maxCad })}
            active={state.costMaxCad === opt.maxCad}
            count={countFor('costMax', opt.maxCad == null ? 'any' : String(opt.maxCad))}
          >
            {opt.label}
          </Chip>
        ))}
      </Group>
    ),

    /* Near me — origin + travel radius (radius shown once an origin is set). Two origins:
       browser geolocation (NearMeButton, anyone) and the signed-in user's saved location
       (a plain Link — no browser permission needed; only rendered when we resolved it). */
    nearMe: (
      <Group label="Near me" id="kf-fg-near" key="nearMe">
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
            <Chip
              key={km}
              href={hrefFor(state, { radiusKm: km })}
              active={state.radiusKm === km}
              count={countFor('nearMe', String(km))}
            >
              {km} km
            </Chip>
          ))}
      </Group>
    ),
  };

  const primary = plan ? plan.primary : RAIL_GROUP_ORDER;
  const secondary = plan ? plan.secondary : [];

  return (
    <div className="kf-filters" aria-label="Filters">
      {primary.map((id) => groups[id])}

      {/* Folded groups. A native <details> so it needs no JavaScript, is keyboard-operable
          and announces its own expanded state — and, critically, keeps every folded chip in
          the DOM as a real <Link>, so a deep link into a folded group still resolves and the
          URL contract is unchanged. Nothing a parent has already applied lands here
          (rail-groups.ts pins applied groups to `primary`). */}
      {secondary.length > 0 && (
        <details className="kf-filters__more">
          <summary className="kf-filters__more-sum">
            More filters
            <span className="kf-filters__more-n" aria-hidden="true">
              {secondary.length}
            </span>
          </summary>
          <div className="kf-filters__more-body">{secondary.map((id) => groups[id])}</div>
        </details>
      )}

      {hasClearableFilters(state) && (
        <div className="kf-filters__foot">
          <Link className="kf-filters__clear" href={hrefFor(state, CLEARED_FILTERS)}>
            Clear filters
          </Link>
        </div>
      )}
    </div>
  );
}
