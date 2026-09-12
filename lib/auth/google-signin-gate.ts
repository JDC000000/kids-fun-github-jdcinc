// lib/auth/google-signin-gate.ts — the single switch that decides whether this product offers a
// Google sign-in at all.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────
// Jon, 2026-09-12: *"nobody can sign in with google."* An earlier change removed the sign-in
// BUTTON from the nav and the /search save bar, which made the capability undiscoverable but left
// it fully working: `/auth/signin` still 307'd into Supabase's `/authorize?provider=google`, and
// `/account` still redirected anonymous visitors straight into that flow. Verified against the
// live production domain on 2026-09-12, BEFORE this file existed:
//     GET https://kidsfunapp.ca/auth/signin  →  307 → rnqaofjhiqmqaipqpiua.supabase.co/auth/v1/
//                                               authorize?provider=google&redirect_to=…/auth/callback
//     GET https://kidsfunapp.ca/account      →  307 → /auth/signin?next=/account
//     (and that Supabase endpoint 302s to accounts.google.com with a real client_id — the
//      provider is genuinely configured, not a stub)
// So "the button is gone" was never the same statement as "nobody can sign in", and this module
// is what makes the second one true.
//
// ── A CONSTANT, NOT AN ENV FLAG — A DELIBERATE DEPARTURE FROM THE HOUSE PATTERN ───────────
// The repo's existing gate is `smsSignupEnabled()` in lib/sms/config.ts: `env('SMS_SIGNUP_ENABLED')
// === 'true'`. That shape is right for THAT flag, which gates a feature that is being rolled out
// and legitimately differs per environment. This one is not that. It encodes a product decision
// that is the same everywhere, so:
//   · an env flag would make production safety depend on an env var being ABSENT, and one
//     `GOOGLE_SIGN_IN_ENABLED=true` in a dashboard would silently restore a capability that was
//     removed for product-trust reasons, with no diff and no review;
//   · a constant means re-enabling is a code change, which is the correct gate for reversing it.
// Reversing is still one line, and this file is the only place that would change.
//
// ── RULED ON, NOT LEFT OPEN (Operator, 2026-09-12) ───────────────────────────────────────
// This paragraph used to end "if the Operator prefers the env-flag shape for consistency, this is
// the only place that changes" — an open question, raised because departing from the house
// pattern deserved a second opinion. It was put to the Operator and decided. Verbatim:
//
//   "given Jon's explicit 'full stop, nobody signs in with Google' instruction, a hard-coded
//    constant that requires an actual code change and review to reverse is a MORE faithful
//    implementation of his intent than an env flag... keep the constant."
//
// Recorded here rather than left in a message thread, because the deviation from
// lib/sms/config.ts's env-flag idiom is exactly the kind of thing a later reader "fixes" for
// consistency — and an env flag is precisely what was considered and rejected. If you are here
// to make this match the house pattern: that has been decided against, on the grounds above.
// Changing it needs a new ruling, not a tidy-up.
//
// ── TYPED `boolean`, NOT INFERRED `false` ────────────────────────────────────────────────
// Annotated so TypeScript does not narrow it to the literal `false` and report every guarded
// branch below it as unreachable dead code. The value is meant to be read, not constant-folded.
export const GOOGLE_SIGN_IN_ENABLED: boolean = false;

/**
 * What the gated routes return.
 *
 * 404, not 403 and not a "sign-in is disabled" page. The capability does not exist in this
 * product any more, and 404 is the honest description of that — it is also exactly what
 * app/sms/signup/page.tsx does for its own disabled feature, so the codebase has one answer to
 * "this route is switched off" rather than two.
 *
 * NOTE for whoever re-enables this: `/auth/callback` is INDEPENDENTLY REACHABLE. It is a bare GET
 * taking a `code` query param and does not require the visitor to have passed through
 * `/auth/signin` first, so gating only the initiation route would have left a working way to
 * mint a session. Both are gated, and both must stay gated together.
 */
export function googleSignInGoneResponse(): Response {
  return new Response(null, { status: 404 });
}
