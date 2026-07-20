import Link from 'next/link';
import './site-footer.css';

// SiteFooter — minimal global footer chrome (Round 27, PIPEDA F-1). Mounted once in
// the root layout so a site-wide Privacy Policy link is reachable from every route.
//
// Server component, zero client JS. Styling is self-contained (not scoped under .kf)
// and consumes the canonical global --kf-* tokens, mirroring AccountNav's chrome bar
// so the top (account) and bottom (footer) chrome are consistent. Deliberately small:
// a wordmark + a single legal link — not a redesign.

export function SiteFooter() {
  return (
    <footer className="kf-site-footer">
      <div className="kf-site-footer__inner">
        <span className="kf-site-footer__word">KIDS FUN</span>
        <nav className="kf-site-footer__nav" aria-label="Legal">
          <Link className="kf-site-footer__link" href="/privacy">
            Privacy Policy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
