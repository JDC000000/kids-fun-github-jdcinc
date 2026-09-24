import Link from 'next/link';
import './_components/home.css';
import { Button, Input } from '@/components/ui';
import { destinationHref, liveCategoryDestinations } from './_lib/nav-destinations';
import { ThreeThings } from './_components/ThreeThings';
import { SmsSignupCta } from './_components/SmsSignupCta';
import { smsSignupAvailability } from '@/lib/sms/availability';
import { recordSmsOfferViewed } from '@/lib/analytics/record';
import { START_CTA, START_HEADING } from './sms/start/copy';
import {
  SENDER_IDENTITY,
  SUPPORT_PHONE_HREF,
  legalFooterParts,
} from '@/lib/sms/consent-copy';

// Home / front door — THE SMS OFFER (TSD v1.2 §9 M2, design gate G2 approved 2026-09-13).
//
// ═══ WHAT THIS PAGE IS NOW, AND WHAT IT STOPPED BEING ═══
// It was the front door for activity SEARCH: a hero whose main control was a search box, then a
// profile prompt, three picks, a category grid, quick-start chips and an evidence line. Jon's
// instruction re-prioritised it outright — "it should heavily promote SMS. this will be 90% of
// it. below the fold is ok to allow for a search engine and keep the site active."
//
// So the page is now FOUR blocks in one fixed order (TSD §6.1), and the order is the requirement:
//
//   1  the offer      the SMS product + exactly ONE primary action          ← the fold, SMS only
//   2  the proof      <ThreeThings />, framed as a sample of the weekly text   ← still the 90%
//   3  trust + terms  provenance, and compliance reachable in one step (AC-13)  ← still the 90%
//   ── the weight boundary: the ground changes, the type steps down ──
//   4  search         the relocated search form + compact category tiles     ← the WHOLE 10%
//
// ═══ THE 90/10 IS A TESTABLE CLAIM, NOT A VIBE (TSD §6.2) ═══
// At 390x844 the FIRST SCREEN CONTAINS ZERO SEARCH AFFORDANCES — no search input, no category
// tile, no quick-start chip. That is why the search form moved out of the hero rather than being
// demoted inside it, and why the quick-start chips left this page entirely (they remain on
// /search, where a search-narrowing shortcut is worth its height). M4's e2e spec asserts it.
//
// ═══ WHY THE PROOF BLOCK'S FRAMING IS LOAD-BEARING (TSD §6.3) ═══
// Three activity cards are visually substantial. Headed "browse some activities" they read as
// search content and spend the entire 10% budget on their own; headed "a sample of what your
// weekly text looks like" they are SMS proof and sit inside the 90%. The same component lands on
// either side of the ratio depending on one heading, which is why <ThreeThings /> now renders as
// a message thread rather than as tappable cards (see that file).
//
// Server component. The client islands are the CTA (which fires the funnel's click event) and
// nothing else — the ask-once child-profile prompt MOVED TO /search (TSD T2.4/T2.5): it was the
// product's ONLY profile-capture surface, and removing it from here without relocating it would
// have silently taken age personalisation off /search for every new visitor.

/**
 * PER-REQUEST RENDER, and this is the architectural consequence of the whole feature.
 *
 * This page was statically prerendered: no `dynamic`, no `fetch`, no `headers()` — HTML built
 * once and served with no data access. `<ThreeThings />` evaluates a real search in process, so
 * the page has to be rendered per request, exactly as /search already declares itself
 * (app/search/page.tsx). The Operator ruled on the alternative and the reasoning is worth keeping
 * next to the line it justifies: "the whole feature's premise is 'the answer is already there
 * when you arrive' and a client-hydrated version would defeat that". A static page whose answer
 * arrives after hydration is not an answer before search; it is the old strip with a new name.
 *
 * IT NOW CARRIES A SECOND LOAD. The fail-safe flag read (AC-12) and the server-side impression
 * (AC-09) are both free BECAUSE of this line: the page already re-renders per request, so the
 * flag is re-read every time and flipping it takes effect WITHOUT A REBUILD. On a statically
 * prerendered page the check would have been baked in at build time and would have lied for as
 * long as the deployment lived. Dropping <ThreeThings /> would therefore not be a content change
 * — it would quietly remove the property both of those depend on (TSD assumption A-2).
 *
 * WHAT IT COSTS, MEASURED RATHER THAN ASSUMED (docs/answer-before-search-measurements.md). The
 * expensive half of a search — the catalogue load — is already cached per warm instance
 * (lib/search/postgres-repository.ts `getCachedPostgresListings`), and this page's three slot
 * queries are in-memory passes over that same warm set, sharing it with /search rather than
 * adding a second read model. It is a real cost on a cold instance and a small one when warm.
 */
export const dynamic = 'force-dynamic';

/**
 * ═══ THE PAGE'S OWN TITLE AND DESCRIPTION DESCRIBE THE OFFER, NOT THE GUIDE (T3.3 / AC-10) ═══
 *
 * These said "What's on for your kids across Metro Vancouver" and "A civic field guide to real
 * kids' activities…", which described the product this page used to be the front door for. A
 * search result whose snippet promises a directory and whose page delivers an SMS signup is a
 * bounce, so this is a correctness fix rather than copywriting.
 *
 * BOTH STRINGS ANSWER THE SAME QUESTIONS THE FIRST SCREEN DOES (C-01…C-05), in the same order and
 * the same voice, so the snippet and the page agree: what it is, how often, where, what it costs.
 * Metro Vancouver is stated in both — it is the single fact that stops an out-of-area parent
 * clicking through (AC-15, risk R-03), and a search snippet is where that filtering is cheapest.
 *
 * ⚠ RANKINGS WILL MOVE, AND MORE UNDER 90/10 THAN UNDER A BALANCED SPLIT (TSD §6.5, risk R-04).
 * This is the domain's most-indexed page and it is deliberately shedding most of its topical
 * signal for activity-search queries. The soft archive limits the damage — every search and
 * category page stays live and linked, and the below-boundary block keeps a real internal link
 * path — but the drop is a consequence of a decision already taken, to be watched after release.
 *
 * NOT TOUCHED, DELIBERATELY: `ORIGIN` in app/sitemap.ts and app/robots.ts. `kidsfunapp.ca` is
 * confirmed correct (TSD §4.8, A2 closed) and no domain work is in scope. app/sitemap.ts lists
 * this page `priority: 1.0, changeFrequency: 'daily'`, which remains correct — the front door is
 * still the front door, and <ThreeThings /> still changes its content daily.
 */
export const metadata = {
  title: 'KIDS FUN — one text a week: things to do with your kids in Metro Vancouver',
  description:
    'One text a week with real things to do with your kids in Metro Vancouver. Free to receive. Reply STOP any time.',
};

/**
 * Category entry points — the SAME list the global nav renders (app/_lib/nav-destinations.ts).
 *
 * These were two hand-maintained copies until that file existed, and they had already drifted:
 * different labels for the same query, two encodings of the same URL, and a "Festivals" tile
 * the nav had already dropped as dead. The list decides labels, hrefs and which destinations are
 * offered at all, once, for both surfaces.
 *
 * WHAT CHANGED IN M2 IS THE PRESENTATION, NOT THE SOURCE. The tiles are now label-only chips
 * inside the below-boundary search block: the captions and glyphs were what made them tall, and
 * height is the entire budget down here. Reading a home-page-local copy of the list to shorten
 * them would re-create exactly the drift app/_lib/nav-destinations.ts was written to end, so the
 * shared entries are still the source and only this surface's LAYOUT of them is local.
 */
const CATEGORIES = liveCategoryDestinations();

/**
 * The four facts, in the order a parent asks them (C-02…C-05). C-01 — what it is — is the
 * heading above them.
 *
 * A SPEC SHEET RATHER THAN MARKETING PROSE, which is a design decision from the approved pack
 * and not a layout convenience: a label/value grid is scannable in the two seconds the first
 * screen gets, and it makes the absence of an answer obvious. C-04 (Metro Vancouver) is
 * MANDATORY here — AC-15, and the mitigation for R-03, an out-of-area parent handing over a
 * number for a service that cannot cover them.
 *
 * ⚠ THE EXACT CARRIER DISCLOSURES ARE NOT THESE STRINGS. The cost row summarises; the binding
 * wording is rendered verbatim from lib/sms/consent-copy.ts in the terms block below. See the
 * note there — this page LINKS OR REUSES the consent wording and never restates it.
 */
const OFFER_FACTS: readonly { k: string; v: string }[] = [
  { k: 'How often', v: 'One text a week — Friday morning.' },
  {
    k: 'What you get',
    v: 'A short list of real activities, matched to your kids’ ages and near you.',
  },
  { k: 'Where', v: 'Metro Vancouver.' },
  { k: 'Cost', v: 'Free to receive. Standard message rates apply.' },
];

export default async function Home() {
  /*
   * ═══ THE FAIL-SAFE, EVALUATED PER REQUEST (AC-12) ═══
   * SMS_SIGNUP_ENABLED defaults to FALSE and app/sms/start/page.tsx calls `notFound()` unless it
   * is exactly 'true'. So the DEFAULT state of this product is a signup page that 404s, and a
   * front door that advertised it unconditionally would not be "usually right" — it would be
   * wrong by default and right only while an environment variable happened to be set.
   *
   * THAT MATTERS MORE AFTER M2 THAN IT DID BEFORE IT. The offer is no longer a card in the middle
   * of a search page; it is the whole first screen. A dead action here is the entire front door.
   *
   * Asked HERE rather than inside the offer component so the branch is visible on the page that
   * owns the decision, and asked through lib/sms/availability.ts rather than process.env so this
   * file never learns which variable governs signup.
   */
  const signup = smsSignupAvailability();

  /*
   * ═══ MEASURE THE OFFER, NOT THE RENDER (AC-09, T1.5) ═══
   * Guarded on `signup.available` rather than emitted unconditionally, and the guard is the
   * whole point rather than an optimisation. This event is the DENOMINATOR of the signup
   * conversion rate; the branch below renders no action whenever the flag is off, which — given
   * it defaults to FALSE — is the state the product spends most of its life in. Counting those
   * renders would silently depress the rate with impressions that never had a chance to convert,
   * and the result would read as a product finding rather than as a bug.
   *
   * AWAITED, matching recordSearchPerformed on /search: on a serverless runtime a floating
   * promise can be cut off when the response finishes, so "fire and forget" here would mean
   * "sometimes fire". Best-effort in the only sense that matters — the recorder cannot throw
   * and cannot change what is rendered.
   */
  if (signup.available) {
    await recordSmsOfferViewed('home');
  }

  /*
   * THE COMPLIANCE BLOCK'S WORDS, IMPORTED RATHER THAN WRITTEN (T2.9, AC-13, AC-14).
   * `false` = this is the weekly subscription, not the area waitlist, so the frequency sentence
   * applies. See the note on the terms block below for why none of this is retyped here.
   */
  const footer = legalFooterParts(false);

  return (
    <div className="kf">
      <div className="kf-page">
        {/* `<main>`, NOT A DIV: the page's one content landmark. The nav (`<header>`/`<nav>`)
            and footer live in app/layout.tsx, outside `{children}`, so this wrapper is the
            whole of the page's own content and is exactly what `main` is for. Every other
            page here does the same (privacy, sms/start, account): one wrapper, one `<main>`.
            Without it axe's `landmark-one-main` and `region` both fire — the repo's default
            ruleset (wcag2a/2aa/21a/21aa/22aa) does not include those best-practice rules, so
            losing this element is invisible to our own a11y check. Keep it a `<main>`. */}
        <main className="kf-app kf-home">
          {/* THE FIRST TAB STOP, AND THE ONLY ABOVE-FOLD ROUTE TO SEARCH THAT COSTS NO HEIGHT.
              Off-screen until focused, so it spends nothing of the fold's budget and renders no
              visible search affordance in the first screen. It exists because the search block is
              now deliberately at the END of a long page: a keyboard or screen-reader user who
              wants search should not have to traverse the entire offer to reach it, and "below
              the fold" was never meant to mean "after four blocks of tabbing". */}
          <a className="kf-home__skip" href="#kf-home-search">
            Skip to search
          </a>

          {/* ══ 1 · THE OFFER ═══════════════════════════════════════════════════════════════
              THE FIRST SCREEN IS SMS AND NOTHING ELSE (AC-01, AC-02, AC-03).

              TWO BRANCHES, ONE FOOTPRINT, AND THE DIFFERENCE BETWEEN THEM IS THE ACTION SLOT
              ALONE. The unavailable branch keeps the heading, the facts and the STOP line —
              everything that TELLS a parent the product exists — and replaces only the button
              with a statement. Two reasons, both deliberate:
                · Removing the whole block would move every section below it and read as a
                  rendering fault, and would tell a parent nothing about a thing that genuinely
                  exists and is nearly ready.
                · A DISABLED BUTTON WOULD BE WORSE THAN EITHER. A greyed button still invites a
                  tap. "Render no signup action" has to mean no action, not a dead-looking one —
                  which is what the absence of `signup.href` in that branch enforces: there is no
                  path to link to, so there is nothing to accidentally render as a control.

              `<section class="kf-home__sms …">` IS A TEST CONTRACT, NOT A STYLE CHOICE.
              tests/home/sms-offer.test.tsx locates the offer by exactly this opening tag in both
              flag states, and tests/e2e/public/sms-cta-analytics.public.spec.ts locates the CTA
              by `a.kf-home__sms-cta`. Both names survived the M2 restyle on purpose. ══ */}
          {signup.available ? (
            <section className="kf-home__sms" aria-labelledby="kf-home-sms">
              <div className="kf-home__sms-inner">
                <h1 className="kf-home__sms-title" id="kf-home-sms">
                  {START_HEADING}
                </h1>
                <p className="kf-home__sms-sub">{START_CTA}</p>
                <OfferFacts />
                {/* A FLOW CONTAINER, NOT A ONE-SLOT LAYOUT (DC-01 / AC-18). A second, clearly
                    secondary action could be added here later without re-laying-out the fold —
                    it would stack below on a phone and sit beside on desktop, and the fold stays
                    inside at every tested viewport. NOTHING IS BUILT OR RESERVED FOR IT NOW:
                    this is a constraint on how the container is written, not a feature. */}
                <div className="kf-home__actions">
                  <SmsSignupCta href={signup.href}>Get the weekly text</SmsSignupCta>
                </div>
                <p className="kf-home__sms-micro">Reply STOP any time.</p>
              </div>
            </section>
          ) : (
            <section
              className="kf-home__sms kf-home__sms--unavailable"
              aria-labelledby="kf-home-sms"
            >
              <div className="kf-home__sms-inner">
                <h1 className="kf-home__sms-title" id="kf-home-sms">
                  {START_HEADING}
                </h1>
                <p className="kf-home__sms-sub">{START_CTA}</p>
                <OfferFacts />
                <div className="kf-home__actions">
                  <div className="kf-home__sms-paused" role="status">
                    <b>Signups are paused right now.</b>
                    <span>
                      We are not taking new numbers at the moment. Everything else on this page is
                      live.
                    </span>
                  </div>
                </div>
                <p className="kf-home__sms-micro">Reply STOP any time.</p>
              </div>
            </section>
          )}

          {/* ══ 2 · THE PROOF — still inside the 90% ═══════════════════════════════════════
              Repositioned directly beneath the offer and reframed as a sample of the weekly
              text (T2.6). The component owns its own heading and its message-thread rendering;
              `lib/recommend/three-things.ts` — what it SELECTS — is untouched and out of scope. ══ */}
          <ThreeThings />

          {/* ══ 3 · TRUST AND THE OFFER'S TERMS — still inside the 90% ════════════════════ */}
          <section className="kf-home__trust" aria-labelledby="kf-home-trust">
            <div className="kf-home__trust-inner">
              <h2 className="kf-home__h2 kf-home__h2--lead" id="kf-home-trust">
                Where these come from
              </h2>
              {/* One line of evidence, not three of assertion. This was a three-card "How KIDS
                  FUN works" section and each card was a claim about ourselves with nothing
                  behind it. What was missing was the checkable part: /coverage-status is live
                  and a parent can go and read what we cover instead of reading that we are
                  trustworthy. */}
              <p className="kf-home__trust-line">
                We only list activities from sources with confirmed permission, and every one
                carries its source and the date we last checked it.{' '}
                <Link className="kf-home__link" href="/coverage-status">
                  See which areas we cover, and when each was last checked
                </Link>
                .
              </p>

              {/* ═══ THE OFFER'S TERMS — LINK OR REUSE, NEVER RESTATE (T2.9 / AC-13 / AC-14) ═══
                  AC-13 asks that the offer's terms, the STOP instruction, the sender identity and
                  privacy/terms are reachable from the home page in no more than one step. This
                  block reaches them in ZERO: the disclosures and the identity are rendered here,
                  and Privacy/Terms are one link away.

                  EVERY WORD BELOW IS AN IMPORT. Not one sentence of consent or legal wording is
                  authored on this page, and the reason is mechanical rather than stylistic: the
                  consent wording is VERSIONED (`CONSENT_TEXT_VERSION` in lib/sms/consent-copy.ts)
                  and that version is stamped onto every real subscriber record, so the product can
                  answer "which wording did this person actually agree to?". A second copy of those
                  words on the home page is a copy that can drift out of step with the version
                  stamped on live consent records — precisely the failure the versioning exists to
                  prevent. THAT ARGUMENT HOLDS REGARDLESS OF ANY INSTRUCTION, which is what makes
                  it checkable rather than remembered: `git diff -- lib/sms/consent-copy.ts` must
                  be EMPTY after this milestone, `CONSENT_TEXT_VERSION` included.

                  COMPOSED EXACTLY AS /sms/start COMPOSES IT (StartForm.tsx), from the same
                  `legalFooterParts()` call — including splitting the support sentence around the
                  number so it stays a real `tel:` link. A parent reading this on the phone they
                  are about to sign up with taps it; flattened into prose it is just characters.

                  OPEN, NOT COLLAPSED. /sms/start puts the same block behind a <details> because
                  Jon asked for it to be condensed on the form. Here the block IS the compliance
                  reachability requirement, so hiding it behind a disclosure would spend AC-13's
                  one permitted step on the thing the criterion is about. */}
              <div className="kf-home__terms">
                <p className="kf-home__terms-k">The offer’s terms</p>
                <p className="kf-home__terms-body">
                  {footer.disclosures.join(' ')}
                </p>
                <p className="kf-home__terms-body">
                  {footer.identity}{' '}
                  {footer.support.split(SENDER_IDENTITY.supportPhone)[0]}
                  <a className="kf-home__link" href={SUPPORT_PHONE_HREF}>
                    {SENDER_IDENTITY.supportPhone}
                  </a>
                  {footer.support.split(SENDER_IDENTITY.supportPhone)[1]}
                </p>
                <p className="kf-home__terms-links">
                  <Link className="kf-home__link" href="/privacy">
                    Privacy Policy
                  </Link>
                  <Link className="kf-home__link" href="/terms">
                    Terms of Service
                  </Link>
                </p>
              </div>
            </div>
          </section>

          {/* ══ 4 · THE WEIGHT BOUNDARY, AND SEARCH — THE WHOLE 10% ═══════════════════════
              THE BOUNDARY IS NOT AN ANNOTATION. Below this line the ground leaves brand paper
              for a cool neutral, the type steps down, and the internal rhythm tightens. Three
              simultaneous signals, none of them a label saying "less important".

              WHAT IS IN HERE, AND WHY NOTHING ELSE MAY JOIN IT (TSD §6.3):
                · the search input — a plain GET to /search, behaviour unchanged. That input IS
                  the deliberate route into search (Delta 9). A separate "go to search" link
                  would be a third way to do the same thing.
                · the category tiles — retained, compact, label-only.
              The quick-start chips are GONE from this page. They narrow a search rather than
              naming a destination, which makes them the least valuable thing a 10% budget could
              be spent on; they stay on /search, where they do their job.

              🔴 IT MUST NOT BECOME MENU-ONLY. A section that exists but cannot be found fails
              AC-07 exactly as a deleted one would — which is also why the global nav keeps its
              category row (TSD §6.4) and why the skip link at the top of this page exists. ══ */}
          <section className="kf-home__utility" aria-labelledby="kf-home-search-h" id="kf-home-search">
            <div className="kf-home__utility-inner">
              <h2 className="kf-home__utility-h2" id="kf-home-search-h">
                Search what’s on across Metro Vancouver
              </h2>

              <form className="kf-home__search" action="/search" method="get" role="search">
                <label className="kf-home__search-label" htmlFor="kf-home-q">
                  Search activities
                </label>
                <div className="kf-home__search-row">
                  {/* Canonical primitives (components/ui). The control geometry below the
                      boundary is this page's (a 52px input, an ink-filled submit); the
                      primitives still own the type, the focus ring and the token plumbing.
                      DELIBERATELY NOT `variant="primary"`: Leaf is the brand's ONE action
                      colour and it is spent, once, on the signup CTA above. A leaf-filled
                      Search button down here would be a second action of equal weight, which
                      is the thing AC-03 rules out. */}
                  <Input
                    id="kf-home-q"
                    className="kf-home__search-input"
                    type="search"
                    name="q"
                    placeholder="family swim, storytime, soft play…"
                    autoComplete="off"
                    enterKeyHint="search"
                    aria-label="Search kids' activities across Metro Vancouver"
                  />
                  <Button type="submit" variant="secondary" className="kf-home__search-btn">
                    Search
                  </Button>
                </div>
              </form>

              {/* Tiles don't prefetch: /search prefetches count against the production
                  firewall's per-IP /search budget — see app/search/_components/SearchLink.tsx. */}
              <ul className="kf-home__tiles">
                {CATEGORIES.map((c) => (
                  <li key={c.key}>
                    <Link className="kf-home__tile" href={destinationHref(c)} prefetch={false}>
                      {c.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

/**
 * The offer's spec sheet. Extracted because it renders IDENTICALLY in both fail-safe branches —
 * the flag decides whether there is an action, never what the offer is — and a second hand-typed
 * copy of four facts is how the two branches start disagreeing about the product.
 */
function OfferFacts() {
  return (
    <dl className="kf-home__facts">
      {OFFER_FACTS.map((fact) => (
        <div className="kf-home__fact" key={fact.k}>
          <dt className="kf-home__fact-k">{fact.k}</dt>
          <dd className="kf-home__fact-v">{fact.v}</dd>
        </div>
      ))}
    </dl>
  );
}
