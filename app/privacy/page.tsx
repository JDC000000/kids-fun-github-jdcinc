import './privacy.css';

// /privacy — KIDS FUN privacy policy (Round 27, closes PIPEDA finding F-1: no
// privacy policy existed). The body text below is the FINAL, Jon-approved wording
// from documents/requirements/jon-cartwright/kids-fun-privacy-policy-draft-v0.2-
// ready-for-launch.md, copied VERBATIM. It is a signed-off artifact — do not
// paraphrase, summarise, reorganise, or "improve" it here. Any factual correction
// belongs upstream in that document (and its approval), not in this page.
//
// 2026-08-26: SMS/weekly-text disclosures added (doc revision v0.3) ahead of the
// Twilio Toll-Free Verification filing — fixes a self-contradiction (this page
// said "we do not collect children's ages" with no carve-out for the SMS product,
// which deliberately does), adds the new "Weekly text messages (SMS)" section,
// adds Twilio to the service-provider list, adds SMS-specific retention periods,
// and extends the rights section to cover SMS subscribers (who have no account).
// Applies Jon's ruling on the source proposal's one open decision, verbatim:
// "re privacy - (B) Leave the checkbox as-is" — the consent checkbox in
// lib/sms/consent-copy.ts is unchanged; this page's wording deliberately lists
// all four collected items (including optional category interests) per the
// source document's own reasoning. See the source document's amendment log for
// the full history of this revision.
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
const EFFECTIVE_DATE: string | null = '2026-09-03';

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
                <td data-label="When">When you sign in with Google</td>
                <td data-label="Why we need it">
                  To create and secure your account, and — only if you opt in — to send you the weekly
                  activities email
                </td>
                <td data-label="Required?">Required to have an account (sign-in is via Google)</td>
              </tr>
              <tr>
                <th scope="row">A home postal code</th>
                <td data-label="When">Only if you enter it on your Account page</td>
                <td data-label="Why we need it">
                  To remember your area so we can show &quot;near me&quot; results and, if you opt in,
                  tailor your weekly email to your area
                </td>
                <td data-label="Required?">Optional — you can leave it blank</td>
              </tr>
              <tr>
                <th scope="row">Email updates preference</th>
                <td data-label="When">
                  On your Account page (a checkbox, <strong>off by default</strong>)
                </td>
                <td data-label="Why we need it">To know whether you want the occasional weekly email about new activities</td>
                <td data-label="Required?">Optional — off unless you turn it on</td>
              </tr>
              <tr>
                <th scope="row">Searches you save</th>
                <td data-label="When">Only when you click &quot;Save&quot; on a search</td>
                <td data-label="Why we need it">To let you re-run a search you chose to keep</td>
                <td data-label="Required?">Optional — only what you explicitly save</td>
              </tr>
              <tr>
                <th scope="row">Anonymous usage events</th>
                <td data-label="When">As you use the site</td>
                <td data-label="Why we need it">
                  To understand which searches and listings are useful and to improve results — see
                  &quot;Anonymous usage data&quot; below
                </td>
                <td data-label="Required?">Not tied to your identity</td>
              </tr>
              <tr>
                <th scope="row">Problem reports</th>
                <td data-label="When">If you use &quot;Report wrong info&quot; on a listing</td>
                <td data-label="Why we need it">To let us find and fix inaccurate activity listings</td>
                <td data-label="Required?">Optional — only if you report something</td>
              </tr>
            </tbody>
          </table>

          <p>
            <strong>We do not</strong> collect your name, precise location/GPS coordinates, payment
            information, or children&apos;s names. We do not use advertising or third-party tracking
            pixels. If you sign up for our <strong>weekly SMS messages</strong>, we collect your
            children&apos;s <strong>approximate ages</strong> — see &quot;Weekly SMS messages&quot;
            below. We do not collect children&apos;s ages anywhere else.
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

          <h2>Weekly SMS messages</h2>
          <p>
            The weekly SMS is a <strong>separate, optional product</strong> from the website. You can
            use KIDS FUN without it, and signing up for it is the only way we ever have your phone
            number.
          </p>
          <p>If you sign up, we collect and store:</p>
          <ul>
            <li>
              <strong>Your mobile number</strong> — to send the weekly SMS, and as the only way we
              identify you. There is no account and no password.
            </li>
            <li>
              <strong>Your postal code</strong> — to find activities near you. We store the postal code
              itself, never a precise location.
            </li>
            <li>
              <strong>Your children&apos;s approximate ages</strong> — entered as a plain &quot;how old
              are they now&quot; number per child. We store the <strong>year</strong> they were born, not
              a birthday, so the ages stay right as they grow up. We never ask for a birthday, a month,
              or a child&apos;s name.
            </li>
            <li>
              <strong>The kinds of activity you&apos;re interested in</strong> (optional) — the
              checkboxes you tick at signup or on your preferences page.
            </li>
          </ul>
          <p>
            We use this information <strong>only to choose the activities in that weekly SMS</strong>.
            We do not use it for anything else.
          </p>
          <p>
            <strong>
              Your mobile information — your phone number and everything above — is never sold, and
              never shared with advertisers or any other third party.
            </strong>{' '}
            The only companies that ever see it are the service providers listed below who deliver the
            message on our behalf.
          </p>
          <p>
            Every message we send links to your own <strong>preferences page</strong>, where you can see
            everything we store about you, change your area, your children&apos;s ages or your
            interests, unsubscribe, or delete everything — with no login and no account. You can also
            reply <strong>STOP</strong> to any message to unsubscribe, or <strong>HELP</strong> to reach
            us.
          </p>

          <h2>How we use your information</h2>
          <p>
            We use your information only to run and improve KIDS FUN: to sign you in, remember your area
            and saved searches, send the weekly email or weekly SMS if you asked for it, keep listings
            accurate, and understand overall usage. <strong>We do not sell your personal information,
            and we do not share it for advertising.</strong>
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
              <strong>Twilio</strong> — sends and receives the weekly SMS messages,{' '}
              <strong>only if you signed up for them</strong> (receives your mobile number and the
              message content).
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
            <li>
              <strong>Your SMS details</strong> (mobile number, postal code, children&apos;s
              ages, interests): kept while you are subscribed, and{' '}
              <strong>deleted 30 days after you unsubscribe.</strong> If you use the &quot;delete my
              data&quot; control on your preferences page, they are deleted straight away.
            </li>
            <li>
              <strong>A sign-up that is never confirmed:</strong> if you sign up but never reply JOIN to
              our confirmation SMS, everything we collected is <strong>deleted after 90 days.</strong>
            </li>
          </ul>
          <p>
            After your SMS details are deleted we keep a <strong>scrambled, one-way code</strong>{' '}
            derived from your mobile number — not the number itself, and not reversible — as the record
            that we were allowed to send you SMS. Canadian anti-spam law requires us to be able to answer a
            complaint about a message we sent.
          </p>

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
            <li>
              <strong>If you subscribe to the weekly SMS</strong>, all four of these live on your{' '}
              <strong>preferences page</strong> instead — the link in every message. No login. You can
              see everything we store, change your area, children&apos;s ages and interests,
              unsubscribe, or delete everything.
            </li>
          </ul>

          <h2>How to reach us / raise a concern</h2>
          <p>
            Questions or privacy concerns? Contact us at{' '}
            <strong>
              <a href="mailto:joncartwright00@gmail.com">joncartwright00@gmail.com</a>
            </strong>
            .
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
