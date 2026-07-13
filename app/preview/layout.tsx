import './preview.css';
import type { ReactNode } from 'react';

// Route-scoped layout for the mobile fixture shell. Imports the design-system
// stylesheet and frames the app as a phone (the primary artboard). Kept isolated
// under /preview so the shared root layout + landing page stay untouched for the
// backend/search tracks.

export const metadata = {
  title: 'KIDS FUN — mobile shell (preview)',
  description: 'Fixture-backed mobile-first preview of the KIDS FUN activity index.',
};

export default function PreviewLayout({ children }: { children: ReactNode }) {
  return (
    <div className="kf">
      <div className="kf-page">
        <div className="kf-app">{children}</div>
      </div>
    </div>
  );
}
