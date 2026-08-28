// lib/sms/surfaces.ts — which routes belong to the SMS product.
//
// DRAFT (SMS pivot). One list, owned by this branch, so that a shared component can ask "is this
// an SMS page?" without the SMS product's route map being written down somewhere it does not
// belong.
//
// ═══ WHY THIS EXISTS: PRD §8 item 4, Jon-approved ═══
// Jon, verbatim: *"I don't think it adds value for user. let's emphasize capturing the least
// amount of data we need to provide value."* The shared `AccountNav` renders "Sign in with Google"
// on every page including these, and an SMS subscriber has NO ACCOUNT — that is the product's
// premise. Offering one on the page where somebody is signing up by phone number invites a data
// relationship the product deliberately does not need.
//
// ═══ THE PRINCIPLE IS WORTH KEEPING, NOT JUST THE RULING ═══
// "Capture the least data needed to provide value" is now on the record as Jon's own framing for
// scope calls on this branch. It is the same instinct behind storing a birth YEAR rather than a
// birthday, a postal code rather than a location, and a phone number rather than an account.
//
// The list lives HERE rather than inside the nav component so the policy sits with the product it
// describes: adding an SMS route means adding it to this file, next to everything else that knows
// what the SMS product is.

/** Route prefixes that make up the anonymous SMS product surface. */
export const SMS_SURFACE_PREFIXES = [
  '/sms', //                 the public signup form
  '/u/', //                  the no-login preferences / hub page
  '/activity-unavailable', // the "activity gone" interstitial a text link can land on
] as const;

/**
 * Is this path part of the SMS product?
 *
 * PREFIX MATCHING, and `/u/` carries its trailing slash on purpose: `/u/<token>` is the hub page,
 * but a future top-level `/updates` must not be swept in by a bare `/u`.
 */
export function isSmsSurface(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return SMS_SURFACE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

/**
 * Routes where the ACCOUNT NAV is hidden — a DIFFERENT question from "is this an SMS surface".
 *
 * ═══ WHY THIS IS A SECOND LIST AND NOT THREE MORE ENTRIES IN THE ONE ABOVE ═══
 * Until now the two questions had the same answer, so one list served both. Jon's ruling
 * (2026-08-28) separates them: *"the least data no account paradigm principle extends to the
 * shared pages too."* `/activity/{id}` is NOT an SMS surface — it is the shared web detail page,
 * it predates the SMS product, and the website's own testing track owns it. Adding it to
 * `SMS_SURFACE_PREFIXES` would make that list assert something false about the product's shape,
 * and `isSmsSurface` is a name other code may one day trust to mean what it says.
 *
 * So: the SMS surfaces are hidden because they are SMS surfaces, and `/activity/{id}` is hidden
 * because a parent arrives there by tapping a link in a text — which is the reason Jon gave.
 *
 * ── WHY `/activity/{id}` AND NOT ALSO `/search` ─────────────────────────────────────────
 * `/search` is deliberately ABSENT, pending a decision, for two reasons found while implementing:
 *   1. It carries a SIGNED-IN FEATURE. `SaveSearchButton` (app/search/page.tsx) has explicit
 *      signed-in / signed-out / session-lost states and initiates the OAuth flow. Hiding the
 *      account nav there removes the only sign-out control and the only `/account` link from a
 *      page that still offers a feature requiring an account — a page that would then let someone
 *      save a search without showing them they are signed in.
 *   2. It is not reached from a text. A weekly-text link resolves `/s/{token}` to `/activity/{id}`.
 *      No SMS path lands on `/search`, so Jon's stated rationale — the pages a parent reaches by
 *      tapping a weekly-text link — does not select it.
 * `/activity/{id}` has no auth dependency at all, so it carries neither cost.
 */
export const ACCOUNT_NAV_HIDDEN_PREFIXES = [
  ...SMS_SURFACE_PREFIXES,
  '/activity/', // the shared detail page a weekly-text short link resolves to (Jon, 2026-08-28)
] as const;

/** Should the account touchpoint be hidden on this path? See the list above for why it differs. */
export function hidesAccountNav(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return ACCOUNT_NAV_HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}
