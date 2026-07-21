import './privacy.css';

// /privacy — KIDS FUN privacy policy (Round 27, closes PIPEDA finding F-1: no
// privacy policy existed). The body text below is the FINAL, Jon-approved wording
// from documents/requirements/jon-cartwright/kids-fun-privacy-policy-draft-v0.2-
// ready-for-launch.md, copied VERBATIM. It is a signed-off artifact — do not
// paraphrase, summarise, reorganise, or "improve" it here. Any factual correction
// belongs upstream in that document (and its approval), not in this page.
//
// Server component: static, zero client JS, same convention as /preview and the
// home front door. Styling uses the canonical global --kf-* design tokens so the
// page is dark-mode aware and meets the same WCAG-AA bar as the rest of the site.

export const metadata = {
  title: 'Privacy Policy — KIDS FUN',
  description:
    'How KIDS FUN collects, uses, shares, and protects your personal information under Canada’s PIPEDA.',
};

// Effective date is the ONE value the approved doc says is set at publish time
// ("no reason to guess it now"). It is not a policy decision left open — it is a
// publish-time stamp. Until the page is actually published (this branch is handed
// back to the orchestrator, NOT merged), it is null and the effective-date line is
// omitted entirely rather than rendering a visible unresolved-placeholder artifact.
// The orchestrator sets this to the real publish date (e.g. '2026-07-20') at
// merge/deploy — a one-line change.
const EFFECTIVE_DATE: string | null = '2026-07-21';

export default function PrivacyPage() {
  return (
    <div className="kf kf-privacy">
      <div className="kf-privacy__doc">
        <header className="kf-privacy__header">
          <p className="kf-privacy__wordmark">KIDS FUN</p>
          <h1 className="kf-privacy__title">Privacy Policy</h1>
        </header>

        <main className="kf-privacy__prose">
          {EFFECTIVE_DATE ? (
            <p className="kf-privacy__meta">
              <strong>Effective date:</strong> {EFFECTIVE_DATE}
            </p>
          ) : null}

          <p>
            <strong>Who we are:</strong> KIDS FUN is operated by Jon Cartwright (&quot;we&quot;,
            &quot;us&quot;). KIDS FUN helps parents in Metro Vancouver, BC find local children&apos;s
            activities.
          </p>

          <p>
            We follow the principles of Canada&apos;s{' '}
            <strong>Personal Information Protection and Electronic Documents Act (PIPEDA)</strong>. This
            policy explains, in plain language, what personal information we collect, why, how long we
            keep it, who we share it with, and how you can access or delete it.
          </p>

          <h2 id="kf-privacy-collect">What we collect, and why</h2>
          <p>
            You can browse and search KIDS FUN <strong>without an account</strong>. If you choose to
            create an account or use certain features, here is everything we collect:
          </p>

          <table className="kf-privacy__table" aria-labelledby="kf-privacy-collect">
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">When</th>
                <th scope="col">Why we need it</th>
                <th scope="col">Required?</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Your email address</th>
                <td>When you sign in with Google</td>
                <td>
                  To create and secure your account, and — only if you opt in — to send you the weekly
                  activities email
                </td>
                <td>Required to have an account (sign-in is via Google)</td>
              </tr>
              <tr>
                <th scope="row">A home postal code</th>
                <td>Only if you enter it on your Account page</td>
                <td>
                  To remember your area so we can show &quot;near me&quot; results and, if you opt in,
                  tailor your weekly email to your area
                </td>
                <td>Optional — you can leave it blank</td>
              </tr>
              <tr>
                <th scope="row">Email updates preference</th>
                <td>
                  On your Account page (a checkbox, <strong>off by default</strong>)
                </td>
                <td>To know whether you want the occasional weekly email about new activities</td>
                <td>Optional — off unless you turn it on</td>
              </tr>
              <tr>
                <th scope="row">Searches you save</th>
                <td>Only when you click &quot;Save&quot; on a search</td>
                <td>To let you re-run a search you chose to keep</td>
                <td>Optional — only what you explicitly save</td>
              </tr>
              <tr>
                <th scope="row">Anonymous usage events</th>
                <td>As you use the site</td>
                <td>
                  To understand which searches and listings are useful and to improve results — see
                  &quot;Anonymous usage data&quot; below
                </td>
                <td>Not tied to your identity</td>
              </tr>
              <tr>
                <th scope="row">Problem reports</th>
                <td>If you use &quot;Report wrong info&quot; on a listing</td>
                <td>To let us find and fix inaccurate activity listings</td>
                <td>Optional — only if you report something</td>
              </tr>
            </tbody>
          </table>

          <p>
            <strong>We do not</strong> collect children&apos;s ages, your name, precise location/GPS
            coordinates, payment information, or children&apos;s names. We do not use advertising or
            third-party tracking pixels.
          </p>

          <h2>Anonymous usage data</h2>
          <p>
            To improve the product, we record anonymous events about how the site is used — for example,
            that a search was run, or a listing was viewed. These events are tied to a{' '}
            <strong>random, anonymous browser identifier</strong> (a cookie called{' '}
            <code>kf_anon_id</code>), <strong>not to your name or email</strong>. They deliberately{' '}
            <strong>exclude</strong> your precise &quot;near me&quot; location, your email, and any
            free-text you type beyond the search terms themselves. Because these events are anonymous and
            cannot be reliably linked back to your account, they are not included in your account data
            export. They are <strong>automatically deleted after about 13 months.</strong>
          </p>

          <h2>How we use your information</h2>
          <p>
            We use your information only to run and improve KIDS FUN: to sign you in, remember your area
            and saved searches, send the weekly email if you asked for it, keep listings accurate, and
            understand overall usage. <strong>We do not sell your personal information, and we do not
            share it for advertising.</strong>
          </p>

          <h2>Who we share it with (our service providers)</h2>
          <p>
            We use a small number of service providers who process data on our behalf, under contract,
            only to provide these services:
          </p>
          <ul>
            <li>
              <strong>Google</strong> — sign-in (you authenticate with your Google account).
            </li>
            <li>
              <strong>Supabase</strong> — secure hosting of your account data and our database.
            </li>
            <li>
              <strong>Resend</strong> — sends the weekly email, <strong>only if you opted in</strong>{' '}
              (receives your email address and the email content).
            </li>
            <li>
              <strong>Sentry</strong> — error monitoring, configured to <strong>strip out</strong>{' '}
              personal details (we mask postal codes and remove cookies, sign-in tokens, and IP
              addresses before anything is recorded).
            </li>
          </ul>
          <p>
            We do not otherwise disclose your personal information to third parties, except where
            required by law.
          </p>

          <h2>How long we keep it</h2>
          <ul>
            <li>
              <strong>Your account information</strong> (email, postal code, email preference, saved
              searches): kept until <strong>you delete it or delete your account.</strong> You are in
              control.
            </li>
            <li>
              <strong>Anonymous usage events:</strong> automatically deleted after{' '}
              <strong>about 13 months.</strong>
            </li>
            <li>
              <strong>Problem reports</strong> you submit about listings: retained for up to{' '}
              <strong>6 months</strong>, after which they are automatically deleted.
            </li>
          </ul>

          <h2>How we protect it</h2>
          <p>
            Your data is stored in a secured database with strict access controls (owner-only access
            rules, server-side-only access, encrypted connections). Sign-in cookies are protected (
            <code>httpOnly</code>, same-site). We limit what we collect in the first place, and we redact
            personal details from our error monitoring.
          </p>

          <h2>Your choices and rights</h2>
          <p>Under PIPEDA you can:</p>
          <ul>
            <li>
              <strong>See your data</strong> — download everything we hold about your account from your
              Account page (<strong>Export my data</strong>). This covers your account information
              (email, postal code, preference, saved searches). It does <strong>not</strong> include the
              anonymous usage events described above, because those aren&apos;t linked to your identity.
            </li>
            <li>
              <strong>Correct your data</strong> — edit your postal code, email preference, and saved
              searches at any time on your Account page.
            </li>
            <li>
              <strong>Delete your data</strong> — delete individual saved searches, or{' '}
              <strong>delete your whole account</strong> from your Account page. Deleting your account
              permanently removes your profile and saved searches. We also request removal of your
              sign-in identity from our authentication provider; where that is not yet automated this is
              done on a best-effort basis.
            </li>
            <li>
              <strong>Withdraw consent</strong> — turn off the weekly email at any time (from the
              email&apos;s unsubscribe link or your Account page).
            </li>
          </ul>

          <h2>How to reach us / raise a concern</h2>
          <p>
            Questions or privacy concerns? Contact us at{' '}
            <strong>
              <a href="mailto:joncartwright00@gmail.com">joncartwright00@gmail.com</a>
            </strong>{' '}
            <em>
              (interim contact — will move to a dedicated <code>privacy@</code> address once a domain is
              registered).
            </em>
          </p>
          <p>
            If you have a concern about how we handle your personal information and we haven&apos;t
            resolved it, you can contact the{' '}
            <strong>Office of the Privacy Commissioner of Canada</strong> (priv.gc.ca).
          </p>

          <h2>Changes to this policy</h2>
          <p>We may update this policy; we&apos;ll post the new effective date here.</p>
        </main>
      </div>
    </div>
  );
}
