import { notFound } from 'next/navigation';
import './signup.css';
import { REGION_CHIPS } from '@/app/search/_lib/params';
import { getServerSearchEngine } from '@/lib/search/server-engine';
import { smsSendingEnabled, smsSignupEnabled } from '@/lib/sms/config';
import { SPARSE_FALLBACK_REGION_IDS, sparseRegionIdsFrom } from '@/lib/sms/sparse-areas';
import {
  CONSENT_TEXT_VERSION,
  FORM_HEADING,
  FORM_INTRO,
  LEGAL_FOOTER_SUMMARY,
  SENDER_IDENTITY,
  SUPPORT_PHONE_HREF,
  legalFooterParts,
} from '@/lib/sms/consent-copy';
import { SmsSignupForm } from './_components/SmsSignupForm';

// /sms/signup — the one public destination behind all three of PRD §2.1's doors (QR code,
// "text START to …", email blast). No login, no account: the phone number is the identity.
//
// ── THIS PAGE 404s UNLESS SMS_SIGNUP_ENABLED === 'true' ──────────────────────────────────
// PRD §2.1: "Form stays behind a feature flag until the sign-off gate is recorded" — the gate
// being Jon confirming the privacy-policy changelog entry (§1.3) and the CASL sender-
// identification footer (§1.4). A live form collecting a child's age under unreviewed consent
// copy is precisely what that gate exists to prevent.
//
// notFound(), not a disabled-state page, and matching the API route's own 404: while the gate is
// unrecorded this form does not exist as far as the outside world is concerned. A visible
// "coming soon" page would advertise a consent-collection endpoint on a public host.
//   >>> Reviewing this locally or on staging? Set SMS_SIGNUP_ENABLED=true or you get a 404. <<<
//
// ── WHY IT IS SAFE TO DEPLOY THIS TO STAGING AND TAKE A SCREENSHOT ───────────────────────
// SMS_SIGNUP_ENABLED and SMS_SENDING_ENABLED are separate flags (lib/sms/config.ts) precisely so
// staging can run SIGNUP=true + SENDING=false: the form renders and validates for real, and not
// one text is dispatched and not one consent row is written. The Operator's stated purpose for
// this form — a screenshot as opt-in evidence for the Twilio Toll-Free Verification submission —
// is served by exactly that combination, with no live sending anywhere in it.
//
// ── SERVER COMPONENT; THE ONE THING IT COMPUTES ──────────────────────────────────────────
// The sparse-municipality warning (§2.1) needs to know which areas the catalogue is currently
// thin in. It MEASURES that rather than hardcoding it — see lib/sms/sparse-areas.ts for the
// argument, which is lib/search/coverage.ts's own. The measurement result is handed to the
// client component as a plain array of chip ids, so the form can decide as the parent types
// without a round trip.

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Get weekend activity picks by text — KIDS FUN',
  description:
    'One text a week with 5–10 things to do with your kids that weekend, near you and matched to their ages.',
};

/**
 * Which covered municipalities are currently thin, measured over the live catalogue.
 *
 * ONE SEARCH, no query constraint, all five area chips selected — `SearchResponse.regionCoverage`
 * is the engine's own count and its own `sparse` verdict, which is what /search's identical
 * notice already runs on. Nothing is re-derived here.
 *
 * Falls back to the last-known static list when the engine cannot be built (no database, failed
 * load). See SPARSE_FALLBACK_REGION_IDS for why the fallback warns rather than going quiet.
 */
async function measureSparseRegionIds(): Promise<{ ids: readonly string[]; measured: boolean }> {
  try {
    const engine = await getServerSearchEngine();
    if (!engine) return { ids: SPARSE_FALLBACK_REGION_IDS, measured: false };
    const response = engine.search({
      q: '',
      regionChipIds: REGION_CHIPS.map((c) => c.id),
      minResults: 0,
    });
    const ids = sparseRegionIdsFrom(response.regionCoverage);
    return ids == null ? { ids: SPARSE_FALLBACK_REGION_IDS, measured: false } : { ids, measured: true };
  } catch {
    return { ids: SPARSE_FALLBACK_REGION_IDS, measured: false };
  }
}

export default async function SmsSignupPage() {
  // Staging and development show the internal version line; production does not — see below.
  const isProduction = process.env.NEXT_PUBLIC_APP_ENV === 'production';
  if (!smsSignupEnabled()) notFound();

  const { ids: sparseRegionIds } = await measureSparseRegionIds();

  // Not a waitlist surface: /sms/signup offers the real weekly subscription, so the frequency
  // disclosure is true here and stays.
  const footer = legalFooterParts(false);

  return (
    <main className="kf-sms-signup">
      <div className="kf-sms-signup__panel">
        <h1 className="kf-sms-signup__heading">{FORM_HEADING}</h1>
        <p className="kf-sms-signup__intro">{FORM_INTRO}</p>

        <SmsSignupForm sparseRegionIds={[...sparseRegionIds]} />

        {/*
          Carrier-facing disclosures. Rendered OUTSIDE the consent checkbox on purpose: the
          checkbox carries the PIPEDA/CASL disclosures a subscriber is agreeing to (§1.3), and
          these are standing facts about the service that are true whether or not anyone ticks
          anything. Bundling them into the consent sentence would make an already-long sentence
          longer and blur what is actually being consented to.
        */}
        {/* ── CASL sender identification (§1.4), Jon-approved 2026-08-26. ──
            This block and the support line REPLACED a visible draft banner that stood here while
            the legal name, mailing address and support contact did not exist. They exist now.
            Shared from lib/sms/consent-copy.ts with the other surface that needs them, so the
            address can never be right in one place and stale in the other. */}
        {/*
          COLLAPSED, NOT REMOVED (Jon, 2026-09-01). Every required statement is still on the page
          and still in the DOM — a <details> that is closed has its contents in the document, so a
          compliance reviewer's screenshot, a screen reader and Ctrl-F all still reach them. This
          is a presentation change, not a disclosure change.

          NATIVE <details>, deliberately: no JavaScript, so this page stays a Server Component and
          the whole footer works with JS disabled. A custom toggle would have cost both.

          The number stays a REAL tel: link and Privacy/Terms stay real anchors — see
          legalFooterParts() for why the footer is composed from structure rather than stored as
          one flowing string.
        */}
        <details className="kf-sms-signup__legal-details">
          <summary>{LEGAL_FOOTER_SUMMARY}</summary>
          <p className="kf-sms-signup__legal-body">
            {footer.identity}{' '}
            {footer.support.split(SENDER_IDENTITY.supportPhone)[0]}
            <a href={SUPPORT_PHONE_HREF}>{SENDER_IDENTITY.supportPhone}</a>
            {footer.support.split(SENDER_IDENTITY.supportPhone)[1]}{' '}
            {footer.disclosures.join(' ')}{' '}
            <a href="/privacy">Privacy Policy</a>
            {' · '}
            <a href="/terms">Terms of Service</a>
          </p>
        </details>

        {/*
          Version stamp. `sms_consent.consent_text_version` records which wording a subscriber
          agreed to (migration 0034), and printing it makes a screenshot of this page
          self-identifying — a future dispute can be matched against the page the parent actually
          saw rather than against whatever the page says by then.

          V1 TESTING FOUND IT READS AS LEAKED INTERNALS to an ordinary visitor, which it does:
          "Consent wording 2026-08-26.v2" means nothing to a parent signing their kids up. So the
          VISIBLE line is now non-production only, while the value itself stays in the served HTML
          as a data attribute on every environment.

          THE ATTRIBUTE IS THE PART THAT MATTERED. The audit argument was never about a human
          reading the string off the page — it was about the page being self-identifying to anyone
          who inspects it later. `data-consent-version` does that in production without showing a
          parent a version number, and it survives view-source, `curl`, and archive tooling. What
          it does NOT survive is a purely visual screenshot, which is the one trade here.
        */}
        <p className="kf-sms-signup__version" data-consent-version={CONSENT_TEXT_VERSION}>
          {!isProduction && (
            <>
              Consent wording {CONSENT_TEXT_VERSION}
              {!smsSendingEnabled() && ' · sending disabled in this environment'}
            </>
          )}
        </p>
      </div>
    </main>
  );
}
