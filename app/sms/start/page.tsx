import { notFound } from 'next/navigation';
import './start.css';
import { smsSignupEnabled } from '@/lib/sms/config';
import { measureSparseRegionIds } from '@/lib/sms/sparse-measure';
import { START_CTA, START_HEADING } from './copy';
import { StartForm } from './_components/StartForm';
import type { CoveredRegionId } from '@/lib/geo/postal-fsa';

// /sms/start — the minimal, single-goal signup landing page (Jon's brief, 2026-08-28).
//
// ── A SECOND PAGE, NOT A REPLACEMENT ────────────────────────────────────────────────────
// Jon: "you can design a secondary page using my brief. Keep https://kidsfunapp.ca/sms/signup. We
// can iterate on it closer to launch." So /sms/signup is untouched and keeps its fuller layout,
// its site nav, and PRD §2.1's door-2 catalogue access. This page exists alongside it.
//
// ── GATED IDENTICALLY, AND THAT IS NOT OPTIONAL ─────────────────────────────────────────
// 404s unless SMS_SIGNUP_ENABLED === 'true', exactly like /sms/signup and the API route. The gate
// is Jon's privacy-policy/CASL sign-off, and it exists because "a live form collecting a child's
// age under unreviewed consent copy is precisely what that gate exists to prevent". A second form
// collecting the same data behind a weaker gate would simply reopen the hole the first one closed.
//   >>> Reviewing on staging? SMS_SIGNUP_ENABLED=true, SMS_SENDING_ENABLED=false. <<<
//
// ── NAV-FREE BY DESIGN ──────────────────────────────────────────────────────────────────
// The site chrome is suppressed via BARE_CHROME_PREFIXES (lib/sms/surfaces.ts). That is a decision
// about THIS page only: nav links are friction on a page whose entire job is one conversion. It is
// explicitly NOT a reversal of SiteNav's door-2 reasoning, which still governs /sms/signup.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Fun activities for you and your kids, by SMS — KIDS FUN',
  description:
    'One text a week with things to do with your kids. Postal code, ages, interests, phone number.',
};

export default async function SmsStartPage() {
  if (!smsSignupEnabled()) notFound();

  const { ids } = await measureSparseRegionIds();

  return (
    <main className="kf-start">
      <div className="kf-start__panel">
        {/* Jon's own words, verbatim — see START_HEADING / START_CTA in consent-copy.ts. */}
        <h1 className="kf-start__heading">{START_HEADING}</h1>
        <p className="kf-start__cta">{START_CTA}</p>
        <StartForm sparseRegionIds={ids as readonly CoveredRegionId[]} />
      </div>
    </main>
  );
}
