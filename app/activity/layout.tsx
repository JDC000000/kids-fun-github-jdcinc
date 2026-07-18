import type { ReactNode } from 'react';

// Route-scoped layout for the CANONICAL activity detail route (/activity/[id], T24).
// Mirrors the /preview mobile shell frame (.kf → .kf-page → .kf-app) so the detail
// screen is framed identically on the canonical URL. The design-system stylesheet
// (preview.css) is already imported globally by the root layout, so this only owns
// the phone-frame wrappers — no duplicate styles, no visual difference.

export default function ActivityLayout({ children }: { children: ReactNode }) {
  return (
    <div className="kf">
      <div className="kf-page">
        <div className="kf-app">{children}</div>
      </div>
    </div>
  );
}
