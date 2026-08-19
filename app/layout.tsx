// Canonical design tokens first, so every stylesheet below (and every
// components/ui primitive) resolves against one --kf-* source of truth.
import './design-tokens.css';
import './preview/preview.css';
import type { ReactNode } from 'react';
import { SiteNav } from './_components/SiteNav';
import { SiteFooter } from './_components/SiteFooter';
import { ChildProfileBar } from './_components/ChildProfileBar';

export const metadata = {
  title: 'KIDS FUN',
  description: 'Find kids activities across Metro Vancouver.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteNav />
        {/* "Showing activities for a 3-year-old and a 7-year-old", with the controls that change
            or erase it (U2). Renders nothing until a profile exists, so it costs no chrome to a
            visitor who has never answered the prompt. It sits in the layout rather than on
            /search because the profile is a standing statement that also narrows /search, and
            because /account — the obvious home for a setting — is signed-in only and this
            profile belongs to an anonymous visitor (design §4e). */}
        <ChildProfileBar />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
