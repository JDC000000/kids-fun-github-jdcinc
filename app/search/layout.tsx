import './search.css';
import type { ReactNode } from 'react';

// Route layout for the parent-facing search-results surface (/search) — the first
// real page a parent can type a query into and scan DB-backed results (M3 Screen 2,
// Visual Blueprint v0.2). Frames the app in the same `.kf` phone artboard the shell
// uses; the design-system stylesheet is loaded app-wide via the root layout, and
// search.css adds only the search-bar/browse chrome scoped under `.kf`.

export const metadata = {
  title: 'Search — KIDS FUN',
  description: "Search kids' activities across Metro Vancouver — with the source and last-checked date on every result.",
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
