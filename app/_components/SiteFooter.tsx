import Link from 'next/link';
import './site-footer.css';
// Licence notices we are obliged to publish because the product ships committed
// open-data derivations. Derived FROM those tables, so a future entry with a new
// source appears here with no change to this file. Server-side only — this is a
// server component, so the table never reaches the browser bundle.
import { requiredGeoAttributions } from '@/worker/adapters/activenet/venue-geo';

// SiteFooter — minimal global footer chrome (Round 27, PIPEDA F-1). Mounted once in
// the root layout so a site-wide Privacy Policy link is reachable from every route.
//
// Server component, zero client JS. Styling is self-contained (not scoped under .kf)
// and consumes the canonical global --kf-* tokens, mirroring the chrome bar AccountNav used to draw
// so the top (account) and bottom (footer) chrome are consistent. Deliberately small:
// a wordmark, a legal link, and the data-licence notices — not a redesign.
//
// WHY THE LICENCE NOTICES ARE HERE AND NOT ON THE VENUE DETAIL PANEL (G-VENUE-3, QA
// F1): a per-venue notice can only be as accurate as the UI's knowledge of where that
// venue's coordinates came from, and the UI has none — `venue` has no provenance
// column. Matching on venue name instead produced false OGL claims for coordinates
// that were never City data. A site-wide notice makes no per-venue claim, so it is
// unconditionally true, and it is what the OGL and the ODbL actually ask for.

export function SiteFooter() {
  const attributions = requiredGeoAttributions();
  return (
    <footer className="kf-site-footer">
      <div className="kf-site-footer__inner">
        <span className="kf-site-footer__word">KIDS FUN</span>
        {/* aria-label is "Site information", not "Legal": the coverage link is not a legal
            document, and this is the only global surface it can be reached from. */}
        <nav className="kf-site-footer__nav" aria-label="Site information">
          {/* /coverage-status has been live since the public-coverage work and was linked from
              NOWHERE in the app until this line. It is the one page that lets a parent check a
              coverage claim rather than take it, so it belongs in global chrome, not on one page. */}
          <Link className="kf-site-footer__link" href="/coverage-status">
            Sources &amp; coverage
          </Link>
          <Link className="kf-site-footer__link" href="/privacy">
            Privacy Policy
          </Link>
          <Link className="kf-site-footer__link" href="/terms">
            Terms of Service
          </Link>
        </nav>
      </div>
      {attributions.length > 0 && (
        <div className="kf-site-footer__inner kf-site-footer__attribution">
          <p className="kf-site-footer__credit">
            Venue location data:{' '}
            {attributions.map((a, i) => (
              <span key={a.key}>
                {i > 0 && ' · '}
                <a
                  className="kf-site-footer__link"
                  href={a.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {a.text}
                </a>
              </span>
            ))}
          </p>
        </div>
      )}
    </footer>
  );
}
