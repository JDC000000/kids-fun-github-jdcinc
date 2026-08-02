// Canonical design tokens first, so every stylesheet below (and every
// components/ui primitive) resolves against one --kf-* source of truth.
import './design-tokens.css';
import './preview/preview.css';
import type { ReactNode } from 'react';
import { SiteNav } from './_components/SiteNav';
import { SiteFooter } from './_components/SiteFooter';

export const metadata = {
  title: 'KIDS FUN',
  description: 'Find kids activities across Metro Vancouver.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteNav />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
