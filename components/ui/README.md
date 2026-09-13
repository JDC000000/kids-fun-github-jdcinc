# KIDS FUN — shared UI primitives

The canonical, brand-token-driven building blocks for KIDS FUN. Established in
Round 10 / Task D to give the app one design-system foundation instead of
per-route bespoke CSS.

## Source of truth

- **Tokens:** `app/design-tokens.css` — global `:root` `--kf-*` custom properties
  (colour, type, radius, spacing, elevation, motion) with dark-mode overrides.
  Loaded first in `app/layout.tsx`, so every surface shares one definition.
- **Brand direction:** Brand Workbook V2, Visual Blueprint v0.2, and
  `documents/brand-identities/kids-fun.json`.

## Primitives

| Component | Element | Variants | Use |
|---|---|---|---|
| `Button` | `<button>` or `as` (`a`/`Link`/…) | `primary` (Leaf), `secondary`, `ghost`, `danger` · `size` `md`/`sm` | CTAs and actions. `fullWidth` for action bars. `danger` = red-brown destructive fill for account deletion etc. `as="a"`/`as={Link}` for a real navigation link (keeps right-/middle-click, open-in-new-tab). `size="sm"` for compact list-row density. |
| `Input`  | `<input>`  | — | Single-line text fields. 48px target, 16px font (no iOS zoom), tabular numerals. |
| `Textarea` | `<textarea>` | — | Multi-line text fields. Input's twin — same border/radius/elevation/focus, `resize: vertical`. |
| `Card`   | `as` (div/li/…) | `interactive` | Content surfaces — hairline + Elevation-100. |
| `Badge`  | `<span>` | `confirmed`, `info`, `expected`, `cancelled`, `neutral` | Status/label pills. Colour ALWAYS pairs with the text label you pass (never colour-only). |
| `Chip`   | `<button>` or `as` (`a`/`Link`/`span`) | `rail` (filter/sort/cost pill) · `segmented` (list/map toggle) · `size` `md`/`sm` · `selected` · `action` | SELECTION controls — NOT a Button variant. Caller supplies `aria-current`/`aria-pressed`; the chip owns the fill + ✓ only. `segmented` selected = Forest-ink on Leaf (7.61:1, both schemes) — replaces the old white-on-Leaf toggle that failed AA. |

```tsx
import { Button, Input, Textarea, Card, Badge, Chip } from '@/components/ui';
```

**Polymorphic / compact `Button`.** A matched action pair where one item must stay a
real link and the other a real button can now both adopt the primitive:

```tsx
import Link from 'next/link';
// "Open" is navigation (must be an <a> — new-tab, middle-click); "Delete" is an action.
<Button as={Link} href={hrefForParams(s.params)} variant="secondary" size="sm">Open</Button>
<Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>
```

`size="sm"` changes only the density (36px height, tighter padding/font); colour, radius,
focus ring and disabled treatment are inherited, so shape stays a design decision the
caller can layer via `className` (e.g. a pill radius) without the primitive imposing one.

**Chip — the selection vocabulary (distinct from `Button`).** A `Button` is a CTA; a
`Chip` carries a selected/pressed *state*. The caller keeps its exact `aria-current`
(radio-like) / `aria-pressed` (multi-select) semantics; the chip owns only the fill + ✓.

```tsx
import Link from 'next/link';
// A URL-driven filter chip (radio-like group) — a real link, selected fill + ✓.
<Chip as={Link} href={hrefFor(state, { when: opt.key })} selected={state.when === opt.key}
      aria-current={state.when === opt.key ? 'true' : undefined}>Today</Chip>
// The list/map segmented toggle — a real button, on-state = Forest-ink on Leaf (AA both schemes).
<Chip variant="segmented" selected={view === 'list'} aria-pressed={view === 'list'}
      onClick={() => setView('list')}>List</Chip>
```

All primitives are server-compatible (no `use client`), so they add zero client
JS when used in Server Components.

## Adopted so far

- **Home hero search** (`app/page.tsx`, Round 10 / Task D): `Input` + `Button`.
- **Account** (`AccountForm` / `AccountData` / `SavedSearches`, Rounds 10–12): `Button` (primary/danger/ghost) + `Input`.
- **Search save bar + resume** (`app/search/**`, Rounds 10/12): `Button` + `Badge`.
- **Search bar** (`app/search/_components/SearchBar.tsx`, Round 13 / Task K): `Input` (query) + `Button variant="primary"` (submit — replaces the old white-on-Leaf submit, which failed AA).
- **Search chip/toggle system** (`app/search/**`, Round 14 / Task O): `Chip` across the filter chips (`FilterRail`), the sort/cost chips (`SearchBar`) and the list/map segmented toggle (`SearchResultsView`). The view/map toggle on-state moves white-on-Leaf (2.17:1, FAILED AA) → Forest-ink-on-Leaf (7.61:1) — the same class of contrast fix Task K made on the submit, now closed for good.

## Known near-term consumers (Round 10 parallel streams)

These streams hand-rolled buttons before primitives existed and will refactor
onto them once this lands on main:

- ~~**Saved-search save bar** (`app/search/**`, `kf-savebar__btn`)~~ — removed 2026-09-12 with Google sign-in.
- **Account deletion / export** (`app/account/**`, `kf-account-data__btn`) → `Button variant="danger"` for delete, `variant="secondary"`/`"primary"` for export. (This is why the `danger` variant exists.)

Pattern for consumers: keep your layout class, add the primitive —
`<Button variant="danger" className="kf-account-data__btn" onClick={…}>`. All
native button/input props (onClick, disabled, type, form, aria-*) pass through;
the primitives are server-compatible but work in client components too.

## Not yet adopted (future rounds)

- **Preview status surfaces** — the freshness / booking chips on the activity card +
  detail page → `Badge`, and the card/tile shells → `Card` (`app/preview/**`).
- **`Textarea`** ships here but has no in-app consumer yet: its intended first adopter is the
  account "Save a new search" **Filters** `<textarea>` (`app/account/**`), which Round 12 / Task I
  left native pending this primitive. `/search` has no multi-line field.
- **Polymorphic / compact `Button`** (`as` + `size="sm"`) ships here for the account saved-search
  **Open** (link) + **Delete** (button) pair that Task I left un-migrated; the migration is a future
  account-scope task.
