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

```tsx
import { Button, Input, Textarea, Card, Badge } from '@/components/ui';
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

All primitives are server-compatible (no `use client`), so they add zero client
JS when used in Server Components.

## Adopted so far

- **Home hero search** (`app/page.tsx`, Round 10 / Task D): `Input` + `Button`.
- **Account** (`AccountForm` / `AccountData` / `SavedSearches`, Rounds 10–12): `Button` (primary/danger/ghost) + `Input`.
- **Search save bar + resume** (`app/search/**`, Rounds 10/12): `Button` + `Badge`.
- **Search bar** (`app/search/_components/SearchBar.tsx`, Round 13 / Task K): `Input` (query) + `Button variant="primary"` (submit — replaces the old white-on-Leaf submit, which failed AA).

## Known near-term consumers (Round 10 parallel streams)

These streams hand-rolled buttons before primitives existed and will refactor
onto them once this lands on main:

- **Saved-search save bar** (`app/search/**`, `kf-savebar__btn`) → `Button variant="primary"` + `Input` for naming a search.
- **Account deletion / export** (`app/account/**`, `kf-account-data__btn`) → `Button variant="danger"` for delete, `variant="secondary"`/`"primary"` for export. (This is why the `danger` variant exists.)

Pattern for consumers: keep your layout class, add the primitive —
`<Button variant="danger" className="kf-account-data__btn" onClick={…}>`. All
native button/input props (onClick, disabled, type, form, aria-*) pass through;
the primitives are server-compatible but work in client components too.

## Not yet adopted (future rounds)

- **Preview status surfaces** — the freshness / booking chips on the activity card +
  detail page → `Badge`, and the card/tile shells → `Card` (`app/preview/**`).
- **Search chip/toggle system** (`.kf-fchip`, `.kf-sbar__chip`, `.kf-viewtoggle__btn`)
  is a bespoke **selection** vocabulary (aria-current/aria-pressed + checkmark, scroll-snap
  rails, segmented on/off). It is deliberately NOT force-fit onto `Button` (a CTA, not a
  toggle) — it wants a future dedicated `Chip` / segmented-toggle primitive. See the Round 13
  / Task K findings doc.
- **`Textarea`** ships here but has no in-app consumer yet: its intended first adopter is the
  account "Save a new search" **Filters** `<textarea>` (`app/account/**`), which Round 12 / Task I
  left native pending this primitive. `/search` has no multi-line field.
- **Polymorphic / compact `Button`** (`as` + `size="sm"`) ships here for the account saved-search
  **Open** (link) + **Delete** (button) pair that Task I left un-migrated; the migration is a future
  account-scope task.
