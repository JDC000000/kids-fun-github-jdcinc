// Canonical design tokens first, so every stylesheet below (and every
// components/ui primitive) resolves against one --kf-* source of truth.
import './design-tokens.css';
import { Manrope } from 'next/font/google';
import './preview/preview.css';
import type { ReactNode } from 'react';
import { SiteNav } from './_components/SiteNav';
import { SiteFooter } from './_components/SiteFooter';
import { ChildProfileBar } from './_components/ChildProfileBar';

/**
 * ═══ MANROPE IS SELF-HOSTED. IT USED TO NOT LOAD AT ALL. ═══
 * design-tokens.css and account/account.css each carried an
 * `@import url('https://fonts.googleapis.com/...')`, and NEITHER EVER APPLIED. The CSS spec
 * requires `@import` to precede every other rule, and Next's CSS bundler concatenates component
 * stylesheets ahead of the layout's — so the rule landed ~2.5KB into the bundle and browsers
 * silently dropped it. The brand font has never rendered in production.
 *
 * It went unnoticed because the fallback stack did its job: 'Avenir Next' on Apple, 'Segoe UI' on
 * Windows, Arial elsewhere. All sans, all reasonable — never obviously broken, just never Manrope.
 *
 * `next/font` fixes it by removing the failure mode rather than reordering around it: the font is
 * downloaded at BUILD time and served from our own origin, so there is no `@import`, no ordering
 * question, and no third-party request at runtime. It also means:
 *   · no render-blocking round trip to Google, and no layout shift (a matched fallback is generated)
 *   · no visitor IP disclosed to a third party for a font fetch — worth something on pages that
 *     already handle a child's age
 *   · THE CSP CAN DROP fonts.googleapis.com AND fonts.gstatic.com, which is why Jon chose this
 *     option over a <link> tag. See next.config.mjs.
 *
 * `variable` rather than `className`: the whole product already resolves type through
 * `--kf-font-ui`, so exposing a CSS variable lets that single token keep being the source of truth
 * instead of every component learning about a font object. Weights are the union of what the two
 * old @imports asked for (400-700 plus design-tokens' 800).
 */
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--kf-font-manrope',
  display: 'swap',
});

export const metadata = {
  title: 'KIDS FUN',
  description: 'Find kids activities across Metro Vancouver.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={manrope.variable}>
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
