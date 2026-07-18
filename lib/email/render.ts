// lib/email/render.ts — render a WeeklyDigest into a Resend-ready {subject, html, text}.
//
// Brand voice (documents/kids-fun-alltrails-brand-guidelines-workbook-v2.md): a
// "civic field guide for parents" — quiet, legible, local, useful. Friendliness
// comes from clear choices and honest labels, NOT hype, scarcity, confetti, or
// toy colours. So: restrained palette (Warm paper / Forest ink / one Leaf accent),
// plain-language labels beside every signal, no urgency, no exclamation spam.
//
// Email-client-safe: table layout + inline styles only (no <style>, no flexbox/grid,
// no external CSS). Every piece of dynamic text is HTML-escaped — an activity name
// from an external source can never inject markup. A hidden preheader controls the
// inbox preview line. Pure (no DB/network): the caller passes the unsubscribe URL.
import type { WeeklyDigest } from './digest';
import { appUrl } from './config';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderOptions {
  /** Absolute one-click unsubscribe URL (CASL). */
  unsubscribeUrl: string;
}

// Brand palette (from app/design-tokens.css / brand workbook §3).
const C = {
  paper: '#f7f2e8', // warm page background
  card: '#ffffff',
  ink: '#102316', // forest ink — primary text
  evergreen: '#183b24', // dark trust surface (header)
  leaf: '#48c774', // action accent
  moss: '#5f7360', // AA secondary text on paper
  rule: '#e6eae6', // hairline
} as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a URL for an href attribute (defensive — links are app-built, but never trust blindly). */
function escapeAttr(url: string): string {
  return escapeHtml(url);
}

function subjectFor(digest: WeeklyDigest): string {
  const n = digest.totalActivities;
  return `${n} new ${n === 1 ? 'activity' : 'activities'} for your saved searches`;
}

function activityHtml(a: { name: string; venue: string; when: string; cost: string; url: string }): string {
  return `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid ${C.rule};">
        <a href="${escapeAttr(a.url)}" style="color:${C.ink};text-decoration:none;font-weight:600;font-size:16px;line-height:1.35;">${escapeHtml(a.name)}</a>
        <div style="color:${C.moss};font-size:14px;line-height:1.5;margin-top:4px;">
          ${escapeHtml(a.venue)}<br />
          ${escapeHtml(a.when)} &nbsp;·&nbsp; ${escapeHtml(a.cost)}
        </div>
      </td>
    </tr>`;
}

function sectionHtml(s: { label: string; searchUrl: string; activities: Array<Parameters<typeof activityHtml>[0]> }): string {
  return `
    <tr><td style="padding:24px 0 4px 0;">
      <div style="font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:${C.moss};">New for</div>
      <a href="${escapeAttr(s.searchUrl)}" style="color:${C.evergreen};font-size:18px;font-weight:700;text-decoration:none;">${escapeHtml(s.label)}</a>
    </td></tr>
    <tr><td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${s.activities.map(activityHtml).join('')}
      </table>
    </td></tr>`;
}

export function renderWeeklyDigest(digest: WeeklyDigest, opts: RenderOptions): RenderedEmail {
  const subject = subjectFor(digest);
  const preheader = `${digest.totalActivities} new kid-friendly ${
    digest.totalActivities === 1 ? 'activity' : 'activities'
  } matching what you saved.`;
  const searchAllUrl = appUrl('/search');
  const accountUrl = appUrl('/account');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.paper};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">

        <!-- Header -->
        <tr><td style="background:${C.evergreen};border-radius:12px 12px 0 0;padding:20px 24px;">
          <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:0.02em;">KIDS FUN</div>
          <div style="color:#cfe8d6;font-size:13px;margin-top:2px;">Your weekly kid-friendly finds</div>
        </td></tr>

        <!-- Body card -->
        <tr><td style="background:${C.card};padding:8px 24px 24px 24px;">
          <p style="color:${C.ink};font-size:16px;line-height:1.6;margin:20px 0 4px 0;">Hi there,</p>
          <p style="color:${C.ink};font-size:16px;line-height:1.6;margin:0;">
            Here's what's new since we last wrote — ${digest.totalActivities} new
            ${digest.totalActivities === 1 ? 'activity' : 'activities'} matching your saved searches.
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            ${digest.sections.map(sectionHtml).join('')}
          </table>

          <!-- CTA -->
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 4px 0;">
            <tr><td style="border-radius:8px;background:${C.leaf};">
              <a href="${escapeAttr(searchAllUrl)}" style="display:inline-block;padding:12px 22px;color:${C.ink};font-size:15px;font-weight:700;text-decoration:none;">See more on KIDS FUN</a>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:${C.card};border-radius:0 0 12px 12px;border-top:1px solid ${C.rule};padding:20px 24px;">
          <p style="color:${C.moss};font-size:13px;line-height:1.6;margin:0;">
            You're getting this because you opted in to weekly updates and saved at least one search on KIDS FUN.
          </p>
          <p style="color:${C.moss};font-size:13px;line-height:1.6;margin:10px 0 0 0;">
            <a href="${escapeAttr(accountUrl)}" style="color:${C.moss};text-decoration:underline;">Manage your account</a>
            &nbsp;·&nbsp;
            <a href="${escapeAttr(opts.unsubscribeUrl)}" style="color:${C.moss};text-decoration:underline;">Unsubscribe</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = renderText(digest, opts, { searchAllUrl, accountUrl });
  return { subject, html, text };
}

function renderText(
  digest: WeeklyDigest,
  opts: RenderOptions,
  urls: { searchAllUrl: string; accountUrl: string }
): string {
  const lines: string[] = [];
  lines.push('KIDS FUN — your weekly kid-friendly finds');
  lines.push('');
  lines.push('Hi there,');
  lines.push('');
  lines.push(
    `Here's what's new since we last wrote — ${digest.totalActivities} new ${
      digest.totalActivities === 1 ? 'activity' : 'activities'
    } matching your saved searches.`
  );
  for (const s of digest.sections) {
    lines.push('');
    lines.push(`New for ${s.label}:`);
    for (const a of s.activities) {
      lines.push(`  • ${a.name} — ${a.venue}`);
      lines.push(`    ${a.when} · ${a.cost}`);
      lines.push(`    ${a.url}`);
    }
  }
  lines.push('');
  lines.push(`See more on KIDS FUN: ${urls.searchAllUrl}`);
  lines.push('');
  lines.push('—');
  lines.push("You're getting this because you opted in to weekly updates and saved at least one search on KIDS FUN.");
  lines.push(`Manage your account: ${urls.accountUrl}`);
  lines.push(`Unsubscribe: ${opts.unsubscribeUrl}`);
  return lines.join('\n');
}
