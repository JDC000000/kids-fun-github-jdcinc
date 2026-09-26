import '../_components/interstitial.css';
import {
  LINK_UNAVAILABLE_BODY,
  LINK_UNAVAILABLE_HEADING,
  LINK_UNAVAILABLE_ONWARD,
  SENDER_IDENTITY,
  SUPPORT_SMS_HREF,
} from '@/lib/sms/consent-copy';
import { searchLinkRel } from '@/app/_lib/search-link-rel';

// /link-unavailable — where a tapped weekly short link goes when the TOKEN ITSELF does not verify:
// malformed, truncated, altered in transit, or never minted. The `invalid_token` outcome of
// lib/sms/click-through.ts (mobile audit, 2026-09-11).
//
// ═══ WHAT THIS REPLACES, AND WHY IT WAS WORSE THAN IT LOOKED ═══
// `invalid_token` redirected to a bare `/search`. Nothing on that page mentions the link, so a
// parent who tapped "Sat: Story Time (VPL Renfrew)" in a text landed on an unfiltered results page
// with no heading, no explanation, and no reason to believe anything had gone wrong — they simply
// did not get what they tapped. FALLBACK_DESTINATION's old comment defended it as "the honest 'go
// find something to do' answer"; it was honest about the token and silent about everything else.
//
// The sibling page next door, /activity-unavailable, made exactly this argument in round 9 and won
// it — "landing on /search with no explanation concludes the product is broken more slowly" — and
// then fixed only the OTHER outcome, because Jon's §8 Q3 copy covered a cancelled activity and
// nothing covered a broken link. This is the half that was left.
//
// IT MATTERS OUT OF PROPORTION TO ITS TRAFFIC. The short link in the weekly text is how a beta
// parent FIRST opens this product — no app, no bookmark, no account. And `invalid_token` is not a
// rare adversarial state: it is what a messaging app truncating a URL produces, what a link
// scanner rewriting one produces, and what pasting a link between apps produces.
//
// ═══ WHY IT IS A PAGE AND NOT A 404, AND NOT A BANNER ON /search ═══
// A 404 tells a parent the product is broken. A banner on /search was the other candidate and was
// rejected: it needs a query parameter to carry the reason, that parameter lands in browser
// history and is sent onward as a Referer, and it would put the product's most-loaded page in the
// path of a public unauthenticated redirect for the sake of one sentence. A static page carries
// the sentence, carries no state, and costs nothing to render.
//
// ═══ WHAT THIS PAGE MAY NOT SAY ═══
// NOT "expired". These tokens carry no timestamp and no validity window — lib/sms/short-link.ts
// spends all 76 bits on two short_refs and a 20-bit check — so nothing about them can expire, and
// a link that arrives intact still resolves months later. Inventing an expiry would repeat the
// mistake GONE_DESTINATION explicitly refuses when it declines to tell a parent whose link was
// mangled that an activity was cancelled. See LINK_UNAVAILABLE_BODY for the wording.
//
// NOT WHICH WAY THE TOKEN FAILED. Malformed and checksum-failed reach this page identically, which
// is round 6's property and is unchanged: a page that distinguished them would tell a prober they
// were one character away and turn a 20-bit check into a guided search.
//
// NOT INDEXED, for the same reason as its sibling: it is reachable only by redirect from a link in
// a text message, and a search result pointing at it would be a dead end for whoever clicked.
//
// NO STATE, NO TOKEN, NO IDENTIFIERS. The redirect carries no query string (see the route), and
// this page invents none. That is not decoration: the token is per-subscriber, and a URL that
// echoed it would put it in browser history and hand it to every proxy in between.

export const dynamic = 'force-static';

const ONWARD_HREF = '/search?when=weekend';

export const metadata = {
  title: 'That link didn’t work — KIDS FUN',
  robots: { index: false, follow: false },
};

export default function LinkUnavailablePage() {
  return (
    <main className="kf-interstitial">
      <div className="kf-interstitial__panel">
        <h1 className="kf-interstitial__heading">{LINK_UNAVAILABLE_HEADING}</h1>

        {/* ⚠ OPERATOR-DRAFTED, NOT JON-APPROVED. consent-copy.ts records this in full: the copy on
            the sibling page is the product owner's, delegated and pre-approved, and nothing like
            that exists for these words. They are written to the same bar — match the voice, assert
            nothing false — and they are a placeholder Jon may replace freely. They are marked as
            such rather than quietly inheriting an approval they did not earn. */}
        <p className="kf-interstitial__body">{LINK_UNAVAILABLE_BODY}</p>

        {/* Same support contact as every other surface, from the same constant — a number typed a
            fifth time is a number that will eventually be five different numbers. `sms:`, not
            `tel:`: the label says SMS, and 2026-09-03 fixed exactly this disagreement next door. */}
        <p className="kf-interstitial__support">
          <a href={SUPPORT_SMS_HREF}>SMS {SENDER_IDENTITY.supportPhone}</a>
        </p>

        {/* THE ONWARD LINK CARRIES `when=weekend` BECAUSE THE LABEL SAYS "this weekend".
            A bare `/search` is the unfiltered page this whole change exists to get a parent off;
            sending them back to it under a label promising the weekend would be the same dead end
            with a sentence in front of it. `when=weekend` is the canonical form parsed by
            app/search/_lib/params.ts (WHEN_OPTIONS), not a string invented here.
            It is a /search permutation, so it carries rel="nofollow" like every other one (see
            app/_lib/search-link-rel.ts). That is a crawler hint only: a parent arriving from a
            text taps it exactly as before. The page's own robots metadata already says nofollow;
            this makes the link agree with it. */}
        <p className="kf-interstitial__onward">
          <a href={ONWARD_HREF} rel={searchLinkRel(ONWARD_HREF)}>
            {LINK_UNAVAILABLE_ONWARD}
          </a>
        </p>
      </div>
    </main>
  );
}
