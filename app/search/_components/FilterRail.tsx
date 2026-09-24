import Link from './SearchLink';
import type { ReactNode } from 'react';
import { Button, Chip as UIChip, Input } from '@/components/ui';
import type { AgeBandKey } from '@/lib/search/types';
import {
  AGE_OPTIONS,
  CLEARED_FILTERS,
  RADIUS_OPTIONS,
  REGION_CHIPS,
  TIME_OF_DAY_OPTIONS,
  WHEN_OPTIONS,
  ageSelectionPatch,
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
// ── ONE OPTIONAL EXTENSION (Round 31, desktop rail) ─────────────────────────────────────
// `plan` splits the groups into an up-front set and a folded "More filters" set
// (app/search/_lib/rail-groups.ts). This is what stops a persistent sidebar from being the
// same eight-group wall in a narrower column. It is optional and defaults to OFF, so a caller
// that omits it — today's inline rail, and the mobile bottom sheet that wraps it — gets every
// group, in order.
// Folded groups are still RENDERED, inside a native <details> — every chip stays in the DOM
// as a real <Link>, so the deep-link/back-button architecture and JS-off operability are
// untouched, and a filter the parent has already applied is never folded.
//
// The rail used to take a second extension, `facets`, which put a live result count on every
// chip. That is gone (see the Chip note below); the rail no longer reads the facet payload at
// all. rail-groups.ts still does.

// A URL-driven filter chip: a real <Link> (shareable, back-button-safe, works with JS
// off) on the shared Chip primitive. Selection is fill + ✓ (owned by the primitive) plus
// aria-current="true" — valid on the anchor's implicit role="link" for BOTH the radio-like
// groups (When, Time of day, Radius) and the multi-select toggles (Ages, Areas,
// quick filters). aria-pressed is deliberately NOT used: it is button-only and invalid on a
// link (axe aria-allowed-attr / WCAG 4.1.2 Name, Role, Value).
//
// CHIPS CARRY NO COUNT. Each chip used to render a live facet count — a small numeral beside
// the label, plus a ", N matching" phrase for assistive tech, plus a `data-empty` muting hook
// on the zero-count ones. All of it is gone on Jon's beta feedback: label only.
//
// It is worth being precise about what that removes, because a count is not neutral furniture.
// A number on every option turns a filter rail into a scoreboard the parent is invited to
// optimise against, which is the same "make the user manage result visibility" pattern the
// unknown-cost toggle and the price ceiling were removed for. The parent's job is to say what
// they want; ours is to answer it.
//
// The counts are still COMPUTED (`&facets=1`) — they feed app/search/_lib/rail-groups.ts, whose
// adaptive plan is separately gated off (see page.tsx, QA round 96 F1). Nothing here decides
// that gate; this only stops the numbers being drawn.
function Chip({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <UIChip as={Link} href={href} selected={active} aria-current={active ? 'true' : undefined}>
      {children}
    </UIChip>
  );
}

// A filter group. `optional` appends a quiet, de-emphasized "optional" qualifier to the
// label (Round 30, Jon's hands-on search-UX feedback): it tells a parent the group is safe
// to skip — leaving it untouched applies no filter and shows everything (the confirmed
// default behaviour; see app/search/_lib/params.ts DEFAULT_STATE + intentPhrases). It is the
// unset-is-everything signal for the ONE group that can't use an "Any X" default pill — the
// independent-toggle "Quick filters" group; every other group carries a leading "Any X" chip
// instead (When/Time/Ages/Areas). The qualifier lives inside the labelledby target
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
   * Which groups sit up front and which fold into "More filters"
   * (app/search/_lib/rail-groups.ts). Omit to render all of them in canonical order.
   */
  plan?: RailPlan | null;
}

export function FilterRail({ state, savedLocation, plan }: FilterRailProps) {
  const savedActive = state.useSavedLocation && !!savedLocation;
  // Radius only matters once there's a REAL origin — browser coords, or a saved location
  // we could actually resolve (not merely a ?home=1 flag with no signed-in profile behind it).
  const originActive = hasNearMeCoords(state) || savedActive;

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
       phrase, so results span every age (params.ts intentPhrases).

       BOTH hrefs go through `ageSelectionPatch`, which pairs the band list with the explicit
       `anyAge` flag (params.ts's "Any age" note). Tapping "Any age" and toggling OFF the last
       remaining band are the same statement reached two ways, so both must emit `age=any`
       rather than a bare URL indistinguishable from a parent who never mentioned age. The
       checkmark rule is unchanged — an empty selection reads as "any age" however it got
       there — so nothing about this group LOOKS different; only the URL it produces does. */
    ages: (
      <Group label="Ages" id="kf-fg-ages" key="ages">
        <Chip href={hrefFor(state, ageSelectionPatch([]))} active={state.ages.length === 0}>
          Any age
        </Chip>
        {AGE_OPTIONS.map((opt) => {
          const active = state.ages.includes(opt.key);
          return (
            <Chip
              key={opt.key}
              href={hrefFor(state, ageSelectionPatch(toggleAge(state, opt.key as AgeBandKey)))}
              active={active}
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
        >
          Bookable now
        </Chip>
        <Chip href={hrefFor(state, { dropIn: !state.dropIn })} active={state.dropIn}>
          Drop-in
        </Chip>
        <Chip
          href={hrefFor(state, { rainyDay: !state.rainyDay })}
          active={state.rainyDay}
        >
          Rainy-day
        </Chip>
        <Chip href={hrefFor(state, { free: !state.free })} active={state.free}>
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

       It is the one group whose RIGHT-hand option widens rather than narrows, which is how
       rail-groups.ts decides whether the control is worth showing up front at all (no course
       content held back → nothing to opt into). */
    courses: (
      <Group label="Courses" id="kf-fg-courses" key="courses">
        <Chip
          href={hrefFor(state, { includeRegistration: false })}
          active={!state.includeRegistration}
        >
          Drop-in only
        </Chip>
        <Chip
          href={hrefFor(state, { includeRegistration: true })}
          active={state.includeRegistration}
        >
          {/* "Include registration courses" was 27 characters against 11-20 for every sibling
              label, and one pixel wider than the rail's content box — which is what put a
              permanent horizontal scrollbar on the desktop sidebar. Shortened rather than
              widening the rail, since the label was the outlier, not the container.
              "registration" is kept and "courses" dropped, not the reverse: this chip toggles
              `includeRegistration`, so registration is the word carrying the meaning, and a
              course requires registration by definition. */}
          Include registration
        </Chip>
      </Group>
    ),

    /* The "Max price" group (Any price / Under $20 / Under $50) used to sit here and is GONE
       on Jon's beta feedback — see app/search/_lib/params.ts for why removing the chips was
       only half the job, and why `cost=` is now an unrecognised URL param rather than a
       ceiling with no visible control. The binary "Free" quick filter is unaffected. */

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
