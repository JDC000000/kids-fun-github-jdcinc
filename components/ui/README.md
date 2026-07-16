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
| `Button` | `<button>` | `primary` (Leaf), `secondary`, `ghost`, `danger` | CTAs and actions. `fullWidth` for action bars. `danger` = red-brown destructive fill for account deletion etc. |
| `Input`  | `<input>`  | — | Text fields. 48px target, 16px font (no iOS zoom), tabular numerals. |
| `Card`   | `as` (div/li/…) | `interactive` | Content surfaces — hairline + Elevation-100. |
| `Badge`  | `<span>` | `confirmed`, `info`, `expected`, `cancelled`, `neutral` | Status/label pills. Colour ALWAYS pairs with the text label you pass (never colour-only). |

```tsx
import { Button, Input, Card, Badge } from '@/components/ui';
```

All primitives are server-compatible (no `use client`), so they add zero client
JS when used in Server Components.

## Adopted so far (Round 10 / Task D)

- **Home hero search** (`app/page.tsx`): `Input` + `Button`.

## Known near-term consumers (Round 10 parallel streams)

These streams hand-rolled buttons before primitives existed and will refactor
onto them once this lands on main:

- **Saved-search save bar** (`app/search/**`, `kf-savebar__btn`) → `Button variant="primary"` + `Input` for naming a search.
- **Account deletion / export** (`app/account/**`, `kf-account-data__btn`) → `Button variant="danger"` for delete, `variant="secondary"`/`"primary"` for export. (This is why the `danger` variant exists.)

Pattern for consumers: keep your layout class, add the primitive —
`<Button variant="danger" className="kf-account-data__btn" onClick={…}>`. All
native button/input props (onClick, disabled, type, form, aria-*) pass through;
the primitives are server-compatible but work in client components too.

## Not yet adopted (future rounds — see the Task D findings doc)

The status surfaces where `Badge` / `Card` belong live under `app/preview/**` and
`app/search/**`, which were **out of scope** this round to avoid collisions with
the parallel saved-search and account streams. Next round: swap the freshness /
booking chips on the activity card + detail page to `Badge`, and the card/tile
shells to `Card`. The tokens are already there — the migration is mechanical.
