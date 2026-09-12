import { notFound } from 'next/navigation';
import './start.css';
import { smsSignupEnabled } from '@/lib/sms/config';
import { measureSparseRegionIds } from '@/lib/sms/sparse-measure';
import { START_CTA, START_HEADING } from './copy';
import { StartForm } from './_components/StartForm';
import type { CoveredRegionId } from '@/lib/geo/postal-fsa';

// /sms/start — the minimal, single-goal signup landing page (Jon's brief, 2026-08-28).
//
// ── IT STARTED AS A SECOND PAGE. IT IS NOW THE ONLY ONE ─────────────────────────────────
// Jon commissioned this on 2026-08-28 as a secondary page: "you can design a secondary page using
// my brief. Keep https://kidsfunapp.ca/sms/signup. We can iterate on it closer to launch." For
// four days that was true, and this comment used to say so — that /sms/signup kept its fuller
// layout, its site nav, and PRD §2.1's door-2 catalogue access, alongside this page.
//
// THAT STOPPED BEING TRUE ON 2026-09-01 and the comment did not follow, which is the only reason
// it is worth this many lines now: a later scoping document read it as current fact and raised a
// whole open question ("which of the two signup pages should a CTA point at?") about a choice
// that no longer existed.
//
// What actually shipped that day:
//   • next.config.mjs added `{ source: '/sms/signup', destination: '/sms/start', permanent: true }`
//     — a 308. /sms/signup is not a page a parent can reach; it is a redirect at the edge, and
//     app/sms/signup/page.tsx's own gate is unreachable because the request arrives HERE instead.
//   • lib/sms/surfaces.ts added '/sms/signup' to BARE_CHROME_PREFIXES, recording that Jon "ruled
//     the other way" on the door-2 nav reasoning quoted below. So the site nav is suppressed on
//     both, not just this page.
//
// ⚠ THE REDIRECT IS LOAD-BEARING — do not "clean it up". It is what keeps every already-printed
// QR code and every externally shared /sms/signup link working. Removing it breaks physical
// assets that are already in the world, silently, and no test in this repo renders a poster.
//
// ── GATED IDENTICALLY, AND THAT IS NOT OPTIONAL ─────────────────────────────────────────
// 404s unless SMS_SIGNUP_ENABLED === 'true', exactly like /sms/signup and the API route. The gate
// is Jon's privacy-policy/CASL sign-off, and it exists because "a live form collecting a child's
// age under unreviewed consent copy is precisely what that gate exists to prevent". A second form
// collecting the same data behind a weaker gate would simply reopen the hole the first one closed.
//   >>> Reviewing on staging? SMS_SIGNUP_ENABLED=true, SMS_SENDING_ENABLED=false. <<<
//
// ── NAV-FREE BY DESIGN ──────────────────────────────────────────────────────────────────
// The site chrome is suppressed via BARE_CHROME_PREFIXES (lib/sms/surfaces.ts). When this page was
// written that was a decision about THIS page only — nav links are friction on a page whose entire
// job is one conversion — and explicitly NOT a reversal of SiteNav's door-2 reasoning, which then
// still governed /sms/signup. Jon has since ruled the other way (2026-09-01): both entries sit in
// BARE_CHROME_PREFIXES, and door-2 no longer governs anywhere. See the note at the top.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Fun activities for you and your kids, by SMS — KIDS FUN',
  description:
    'One SMS a week with things to do with your kids. Postal code, ages, interests, phone number.',
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
