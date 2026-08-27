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
