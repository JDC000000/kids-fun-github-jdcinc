'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { hidesSiteChrome } from '@/lib/sms/surfaces';

/**
 * Renders the site chrome everywhere EXCEPT the routes that are deliberately bare.
 *
 * ═══ WHY A WRAPPER RATHER THAN A CHECK INSIDE EACH COMPONENT ═══
 * SiteNav and ChildProfileBar are client components and could ask `usePathname()` themselves, the
 * way SiteNav used to for `hidesAccountNav` (that call site went with the account pill,
 * 2026-09-12). SiteFooter CANNOT — it is a Server Component,
 * and there is no pathname on the server in the App Router.
 *
 * One gate handles all three uniformly instead of two mechanisms for the same decision, and it
 * puts "which pages are bare" in one visible place in the layout rather than scattered across
 * three files. Passing a Server Component through as `children` is fine: it renders on the server
 * and this simply declines to display it.
 */
export function BareChromeGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (hidesSiteChrome(pathname)) return null;
  return <>{children}</>;
}
