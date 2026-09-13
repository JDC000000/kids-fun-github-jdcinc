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
  // The "that link did not work" interstitial (mobile audit, 2026-09-11). Added HERE and not only
  // to ACCOUNT_NAV_HIDDEN_PREFIXES below, because this genuinely IS an SMS surface by the test
  // that list's own comment sets: it exists only to be redirected to from /s/{token}, it is
  // reachable no other way, and nothing outside the SMS product links to it. Its sibling directly
  // above is here for exactly the same reason.
  '/link-unavailable',
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
 * ── `/search` TOO — JON OVERRODE THE RECOMMENDATION, KNOWING THE COST ───────────────────
 * `/search` was held back pending a decision, and the recommendation put to Jon was to leave it
 * alone. He ruled the other way: *"YES"* (2026-08-28). Recorded with BOTH halves, because a
 * ruling that only preserves the winning argument is how the losing one gets rediscovered later
 * and mistaken for a bug.
 *
 * The two reasons it was excluded, found while implementing, both still stand as FACTS:
 *   1. It carries a SIGNED-IN FEATURE. `SaveSearchButton` (app/search/page.tsx) has explicit
 *      signed-in / signed-out / session-lost states and initiates the OAuth flow. Hiding the
 *      account nav removes the only sign-out control and the only `/account` link from a page
 *      that still offers a feature requiring an account.
 *   2. It is not reached from a text. A weekly-text link resolves `/s/{token}` to `/activity/{id}`.
 *      No SMS path lands on `/search`, so the "pages a parent reaches from a text" rationale does
 *      not select it.
 *
 * ⚠ SO #1 IS NOW A KNOWN, ACCEPTED GAP, NOT AN OVERSIGHT. Jon answered with the cost in front of
 * him, and the Operator confirmed closing it is NOT a precondition for shipping this. A signed-in
 * parent on `/search` can still save a search and can no longer sign out from that page; they can
 * from anywhere else in the product. If that turns out to matter, the fix belongs in `/search`'s
 * own UI — giving the page a sign-out affordance of its own — NOT in reverting this list, which
 * would re-break the principle Jon is actually protecting.
 *
 * ── AND NOTE WHAT DID *NOT* CHANGE ──────────────────────────────────────────────────────
 * `/search` is hidden here and is STILL NOT an SMS surface (`isSmsSurface('/search') === false`).
 * That is the whole reason these are two lists rather than one: the nav question and the
 * "is this the SMS product" question now have genuinely different answers, and a single list
 * would have forced a lie about one of them.
 */
export const ACCOUNT_NAV_HIDDEN_PREFIXES = [
  ...SMS_SURFACE_PREFIXES,
  '/activity/', // the shared detail page a weekly-text short link resolves to (Jon, 2026-08-28)
  '/search', // Jon overrode the "leave it alone" recommendation knowingly — see above
  // '/preview/' is where the ruling actually bites. Every activity card in the product —
  // ActivityCard, ResultsMap, the home page's three-things cards — links to /preview/[id], NOT
  // /activity/[id]. So the no-sign-in-on-an-activity-page ruling was being enforced on a path
  // almost nobody takes and defeated on the one everybody does (design audit, 2026-09-03).
  '/preview/',
] as const;

/**
 * Routes that render with NO SITE CHROME AT ALL — no nav bar, no category links, no footer, no
 * child-profile bar. A THIRD question again, and deliberately a third list.
 *
 * ═══ WHY THIS IS NOT SIMPLY "SMS SURFACES" ═══
 * `/sms/start` was first: a single-purpose landing page whose entire job is one conversion —
 * Jon's brief, "One goal... Minimal info, minimal friction." Nav links are friction there by
 * definition.
 *
 * `/sms/signup` JOINED IT on 2026-09-01 (Jon), and this REVERSES an earlier Jon-approved ruling
 * that is worth stating plainly rather than quietly deleting. The old reasoning, which lived here
 * and in SiteNav.tsx, was: *"a parent who lands on the signup form from a QR code should still be
 * able to reach the catalogue. It is the ACCOUNT touchpoint that does not belong, not the
 * navigation."* Jon has now ruled the other way — /sms/signup is a landing/conversion page and the
 * nav is friction on it too, the same judgement already made for /sms/start.
 *   ⇒ The earlier ruling was not wrong on its own terms; it weighed catalogue-reachability above
 *     conversion focus. Jon reweighed it. Both comments were updated rather than removed so the
 *     next reader can see this was decided twice, not overlooked once.
 *
 * WHAT DID NOT CHANGE: this is still not "all SMS surfaces". `/u/…`, `/activity/…` and `/search`
 * remain fully chromed — they are places a person browses or manages something, not single-
 * conversion pages. Anyone tempted to collapse this into SMS_SURFACE_PREFIXES should read that as
 * the reason not to.
 *
 * COMPLIANCE NOTE, checked before this page was added: suppressing chrome also removes SiteFooter,
 * which carries the /privacy and /terms links. Both signup surfaces render their OWN copies in
 * page (see app/sms/signup/page.tsx and StartForm's legal block), so neither loses a required
 * link by going bare. A future page added to this list needs the same check.
 */
/**
 * ═══ /u WAS ADDED 2026-09-03, AND THE EXCLUSION ABOVE WAS RIGHT UNTIL IT WAS ═══
 * The comment above says /u/... stays chromed because it is "a place a person manages something,
 * not a single-conversion page". Jon overruled that for presentation reasons; the reasoning was
 * sound and is left standing rather than deleted, because it is the argument anyone proposing to
 * add /search or /activity should still have to answer.
 *
 * THE COMPLIANCE CHECK THE COMMENT DEMANDS, ACTUALLY PERFORMED. Going bare removes SiteFooter and
 * with it the site-wide /privacy and /terms links. app/u/[preferencesToken] has TWO return
 * branches. The "found" state already rendered its own copies. The NOT-FOUND state did not — it
 * had only a signup link, and would have been left with no path to either document. Those links
 * were added to that branch in the same change as this line, not as a follow-up, and a test now
 * asserts BOTH branches carry them independently of any layout.
 */
export const BARE_CHROME_PREFIXES = ['/sms/start', '/sms/signup', '/u'] as const;

/** Should the whole site chrome be suppressed on this path? */
export function hidesSiteChrome(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return BARE_CHROME_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Should the account touchpoint be hidden on this path? See the list above for why it differs.
 *
 * ⚠ NO PRODUCTION CALLER AS OF 2026-09-12. Jon removed Google sign-in and the `AccountNav`
 * component outright — "we don't want people to sign in with google. this functionality adds
 * no value. remove it." — so SiteNav no longer asks this question and the pill is absent on
 * every route, not just these. The predicate is kept rather than deleted because it is the SMS
 * product's own map of itself and is still covered by tests/sms/surfaces.test.ts; retiring it
 * is a separate decision from removing the pill. The narrative above is therefore HISTORY: the
 * `AccountNav` and `SaveSearchButton` it describes no longer exist.
 */
export function hidesAccountNav(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return ACCOUNT_NAV_HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}
