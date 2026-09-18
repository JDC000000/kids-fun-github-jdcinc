// app/admin/sms-subscribers/_lib/href.ts — admin links that survive the interim token gate.
//
// app/admin/_lib/gate.ts accepts EITHER a real admin session OR the ADMIN_DASHBOARD_TOKEN shared
// secret presented as `?token=`. A link that drops that query param therefore 404s the token
// holder mid-task, because the gate on the next page sees nothing and fail-closes.
//
// This is the admin console's first cross-page drill-down, so it is the first place the problem
// can bite. It is NOT the first place the bug exists: app/admin/operating/trends.tsx:234 builds
// `/admin/operating?view=…` with no token, so a token-authorised admin using the day/month switch
// already 404s today. Reported separately rather than fixed here.
//
// Session-authorised admins are unaffected either way — there is no token to carry, and this adds
// nothing to the URL for them.
import { ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';

export function adminHref(
  path: string,
  searchParams: Record<string, string | string[] | undefined>,
  /**
   * Extra query params to add, e.g. `{ preview: '1' }` for the on-demand SMS preview.
   *
   * Built with encodeURIComponent rather than URLSearchParams on purpose: URLSearchParams encodes
   * a space as '+', which is correct for a form body and wrong-looking in a hand-checked admin
   * URL — and changing that encoding would silently alter the token this function exists to carry
   * intact. The existing behaviour is pinned by tests/admin/sms-subscribers-href.test.ts.
   */
  extra?: Record<string, string>
): string {
  const raw = searchParams[ADMIN_TOKEN_QUERY_PARAM];
  const token = Array.isArray(raw) ? raw[0] : raw;
  const parts: string[] = [];
  if (token) parts.push(`${ADMIN_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`);
  for (const [key, value] of Object.entries(extra ?? {})) {
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  if (parts.length === 0) return path;
  return `${path}?${parts.join('&')}`;
}
