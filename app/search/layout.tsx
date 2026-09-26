import './search.css';
import type { ReactNode } from 'react';

// Route layout for the parent-facing search-results surface (/search) — the first
// real page a parent can type a query into and scan DB-backed results (M3 Screen 2,
// Visual Blueprint v0.2). Frames the app in the same `.kf` phone artboard the shell
// uses; the design-system stylesheet is loaded app-wide via the root layout, and
// search.css adds only the search-bar/browse chrome scoped under `.kf`.

// ═══ robots: noindex, nofollow — ON EVERY /search URL, AND ONLY THERE (2026-09-24, Jon-approved) ═══
// This is crawler cost control. About 96% of the Aug–Sep Vercel bill was GPTBot walking /search
// filter permutations. app/robots.ts disallows /search for crawlers that read robots.txt; this
// covers the ones that fetch the page anyway. app/_lib/search-link-rel.ts is the third layer.
//
// WHY IT LIVES HERE: a segment layout's metadata applies to every page under /search and to no
// other route. It is also STATIC: Next does not re-derive it per query string, so
// /search?anything gets exactly this.
//   - Do not move it to app/layout.tsx; that would noindex the whole site.
//   - Do not turn it into a generateMetadata that reads searchParams; a variant could then
//     escape it.
// tests/search/search-crawl-controls.test.tsx pins both properties.
export const metadata = {
  title: 'Search — KIDS FUN',
  description: "Search kids' activities across Metro Vancouver — with the source and last-checked date on every result.",
  robots: { index: false, follow: false },
};

export default function SearchLayout({ children }: { children: ReactNode }) {
  return (
    <div className="kf">
      <div className="kf-page">
        <div className="kf-app">{children}</div>
      </div>
    </div>
  );
}
