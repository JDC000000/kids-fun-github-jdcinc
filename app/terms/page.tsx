import './terms.css';

// /terms — KIDS FUN Terms of Service.
//
// ⚠ THE BODY TEXT BELOW IS A PROVISIONAL BOILERPLATE DRAFT. IT HAS NOT BEEN
// REVIEWED BY A LAWYER AND IS NOT SIGNED OFF BY ANYONE. It was written to give the
// product terms to point at during beta, not because a reviewed instrument existed.
//
// >>> DO NOT DELETE THE VISIBLE DRAFT NOTICE (the .kf-terms__notice block). <<<
// Its WORDING changed on 2026-09-03 (Jon: replace the first paragraph). This line used to
// name the old title verbatim, which would have made it a pointer to a string that no
// longer exists — so it names the block, not the copy.
// It renders in <main> on purpose. Merging this branch publishes the page to
// production (the Vercel project auto-deploys production on every push to main), so
// a real parent reading a real live page is the person who could rely on unreviewed
// legal text. A code comment like this one reaches developers only; the notice is
// the part that reaches the reader, and it is the whole reason publishing this draft
// is acceptable at all. Remove it only together with the draft status it describes —
// i.e. when reviewed wording actually lands here.
//
// THE NOTICE'S SECOND PARAGRAPH IS NOT PADDING — DO NOT TRIM IT (QA F-3). This page
// says the Privacy Policy "forms part of these Terms" and that together they are the
// whole agreement. With an unqualified draft banner overhead, a reader can reasonably
// infer the Privacy Policy is unreviewed too — and it is the one signed-off, approved
// legal document on this site. A provisional document was lending an approved one its
// own provisional status. The scope clause in the notice, and the matching sentence in
// the "Privacy" section below, exist only to stop that leak. Keep both or neither.
//
// WHY THIS PAGE CARRIES A VISIBLE NOTICE AND /privacy DELIBERATELY DOES NOT:
// the two pages are in OPPOSITE situations, so do not "harmonise" them by deleting
// this one's notice. app/privacy/page.tsx avoids rendering an unresolved-placeholder
// artifact because its CONTENT is final, Jon-approved and copied verbatim from a
// signed-off document — only its publish-time date stamp was outstanding. Here the
// CONTENT ITSELF is provisional. Same repo, same layout idiom, different answer.
//
// Server component: static, zero client JS — no 'use client', no hooks, no event
// handlers, and no next/link (a plain <a> to /privacy does a full navigation and
// keeps this route's client bundle at nothing). Styling uses the canonical global
// --kf-* design tokens, so the page is dark-mode aware and meets the same WCAG-AA
// bar as the rest of the site. Structure mirrors /privacy; none of its text is
// reused — that text is a signed-off artifact and belongs only to that page.

export const metadata = {
  title: 'Terms of Service — KIDS FUN',
  description:
    'The terms that apply when you use KIDS FUN, including what we do and do not promise about the accuracy of activity listings gathered from other sources.',
};

// Same publish-time stamp mechanism as /privacy. It stayed null through QA on purpose,
// so the artifact under review could not move underneath it; the orchestrator set it
// when the findings closed. If the push slips past this date, bump it — it is a
// publish-time stamp, not a decision. The line is omitted entirely while null rather
// than rendering a visible unresolved placeholder, and the "Changes to these Terms"
// wording below is true whether or not a date is showing.
const EFFECTIVE_DATE: string | null = '2026-08-11';

export default function TermsPage() {
  return (
    <div className="kf kf-terms">
      <div className="kf-terms__doc">
        <header className="kf-terms__header">
          <p className="kf-terms__wordmark">KIDS FUN</p>
          <h1 className="kf-terms__title">Terms of Service</h1>
        </header>

        <main className="kf-terms__prose">
          <div className="kf-terms__notice" role="note">
            {/* WORDING REPLACED 2026-09-03 ON JON'S INSTRUCTION. Only the title and this first
                paragraph changed; the scope paragraph below is untouched and must stay — see the
                QA F-3 note in this file's header for why the two are "keep both or neither".

                WHAT THE NEW WORDING DROPS, recorded so nobody later reads it as drift: the old
                text said these terms "have not yet been reviewed by a lawyer". The replacement
                does not say that. It still discloses that the terms are a provisional draft, that
                they may change, that a reader should not rely on them for a decision, and that
                they should ask us instead — which is the substance the header comment calls "the
                whole reason publishing this draft is acceptable at all". The explicit
                no-lawyer-review statement is the one thing gone, and that was the point of the
                instruction rather than a side effect of it.

                "draft" is retained deliberately: the scope paragraph below and the Privacy
                section further down both say "this draft status", and those references need an
                antecedent in this paragraph to resolve against. */}
            <p className="kf-terms__notice-title">These terms may change</p>
            <p className="kf-terms__notice-body">
              These terms are a provisional draft while KIDS FUN is in beta, and may change as the
              product evolves. If something here matters to a decision you&apos;re making, ask us
              rather than relying on it, and check back for updates.
            </p>
            <p className="kf-terms__notice-body kf-terms__notice-scope">
              This draft status applies to <strong>these Terms only</strong>. Our Privacy Policy is a
              separate, finalised document and is in force as written.
            </p>
          </div>

          {EFFECTIVE_DATE ? (
            <p className="kf-terms__meta">
              <strong>Effective date:</strong> {EFFECTIVE_DATE}
            </p>
          ) : null}

          <p>
            These Terms of Service (the &quot;Terms&quot;) are an agreement between you and KIDS FUN,
            operated by Jon Cartwright (&quot;we&quot;, &quot;us&quot;). They apply whenever you visit
            or use the KIDS FUN website. By using KIDS FUN, you agree to these Terms. If you do not
            agree with them, please do not use the service.
          </p>

          <h2>What KIDS FUN is</h2>
          <p>
            KIDS FUN is a <strong>directory</strong>. We gather information about children&apos;s
            activities across Metro Vancouver from other people&apos;s sources — recreation and
            community-centre websites, registration systems, and public event listings — and present
            it in one place so that it is easier to search.
          </p>
          <p>
            We do not run the activities we list. We are not the organizer, and we are not affiliated
            with, endorsed by, or acting as an agent for the providers whose activities appear on the
            site. Registration, payment, attendance, supervision, changes, cancellations, and refunds
            are all between you and the provider, under that provider&apos;s own terms.
          </p>

          <h2 id="kf-terms-listings">Listing information is provided without any warranty</h2>
          <p>
            <strong>This is the most important thing to understand about KIDS FUN.</strong>
          </p>
          <p>
            Listing details — dates, times, ages, prices, locations, availability, registration
            deadlines, contact information — come from third parties and are reproduced
            automatically. They can be out of date, incomplete, mis-read by our software, or simply
            wrong, and an activity can change or be cancelled without that change ever reaching us.
          </p>
          <p>
            We therefore make <strong>no warranty, representation, or guarantee</strong> that any
            listing is accurate, current, complete, or still available. We do not vet the providers
            themselves, and we make no assessment of the suitability, quality, or safety of any
            activity for your child.
          </p>
          <p>
            <strong>
              Always confirm the details directly with the provider before you rely on them
            </strong>{' '}
            — before travelling to a location, paying a fee, or making any arrangement for your
            child. Where a listing links out to the provider, that link is the authoritative source,
            not our copy of it.
          </p>
          <p>
            If you spot something wrong, please use the &quot;Report wrong info&quot; link on the
            listing. Corrections from parents are a large part of how the directory stays useful.
          </p>

          <h2>Your account</h2>
          <p>
            You can browse and search KIDS FUN without an account. If you create one (sign-in is
            through Google), you are responsible for keeping access to it secure and for what happens
            under it. Accounts are for personal, non-commercial use by adults; if you are under the
            age of majority where you live, please use the site with a parent or guardian. You can
            delete your account at any time from your Account page.
          </p>

          <h2>Acceptable use</h2>
          <p>You agree not to:</p>
          <ul>
            <li>
              scrape, crawl, harvest, or bulk-copy listings, or use automated means to access the
              service beyond ordinary browsing;
            </li>
            <li>
              republish, resell, or redistribute our listings or our compilation of them as your own
              product or dataset;
            </li>
            <li>
              interfere with the service or place unreasonable load on it, or attempt to bypass its
              security, rate limits, or access controls;
            </li>
            <li>
              probe for vulnerabilities, or access accounts, data, or areas of the service that are
              not yours;
            </li>
            <li>
              submit false, misleading, abusive, or unlawful content, including through problem
              reports;
            </li>
            <li>
              use the service to break the law, to infringe anyone&apos;s rights, or to harass anyone;
            </li>
            <li>misrepresent your affiliation with a provider, or use the service to advertise.</li>
          </ul>
          <p>
            We may limit, suspend, or end access to the service if these Terms are breached, or where
            we need to protect the service, its users, or ourselves.
          </p>

          <h2>Reports and other things you send us</h2>
          <p>
            When you send us a problem report or other feedback, you keep whatever rights you have in
            it, and you give us permission to use it to operate and improve KIDS FUN — including to
            correct a listing and to pass the corrected listing information on to the provider,
            without your personal details. Please do not send us anything confidential, or anything
            you do not have the right to share. Personal
            information is handled as described in our{' '}
            <a href="/privacy">Privacy Policy</a>.
          </p>

          <h2>Our content and other people&apos;s</h2>
          <p>
            The KIDS FUN name, the design of the site, and the compilation and presentation of the
            listings are ours. The underlying listing information belongs to the providers and other
            sources it came from, and some of the data we use is published under open-data licences,
            which are credited in the site footer. You are welcome to link to KIDS FUN and to use it
            personally; anything beyond that needs our permission.
          </p>

          <h2>Availability and changes to the service</h2>
          <p>
            KIDS FUN is in active development and is offered on an &quot;as available&quot; basis. We
            may change, suspend, add, or remove features, listings, or the service as a whole at any
            time. We do not promise any particular uptime or performance, or that a listing or
            feature you used before will still be there later. That is about the service and its
            listings — the account information you give us is kept, and deleted, as described in our{' '}
            <a href="/privacy">Privacy Policy</a>.
          </p>

          <h2>No warranty</h2>
          <p>
            To the fullest extent permitted by law, KIDS FUN is provided <strong>&quot;as is&quot;</strong>{' '}
            and <strong>&quot;as available&quot;</strong>, without warranties of any kind, whether
            express, implied, or statutory — including any implied warranty of merchantability,
            fitness for a particular purpose, non-infringement, accuracy, or uninterrupted or
            error-free operation.
          </p>
          <p>
            Some jurisdictions do not allow certain warranties to be excluded. Where that is the case,
            the exclusions above apply only as far as the law allows.
          </p>

          <h2>Limitation of liability</h2>
          <p>To the fullest extent permitted by law:</p>
          <ul>
            <li>
              we are not liable for any indirect, incidental, special, consequential, exemplary, or
              punitive damages, or for lost profits, lost data, or lost opportunity, arising out of or
              relating to your use of KIDS FUN;
            </li>
            <li>
              we are not liable for anything arising out of your dealings with a provider or your
              attendance at an activity — including inaccurate listing information, an activity that
              was changed or cancelled, a fee you paid, or any injury or loss occurring at an
              activity;
            </li>
            <li>
              our total liability for all claims relating to KIDS FUN is limited to the greater of
              (a) the amount you paid us in the twelve months before the claim, which for a free
              service is nothing, and (b) CAD $100.
            </li>
          </ul>
          <p>Nothing in these Terms limits liability that cannot be limited by law.</p>

          <h2>Indemnity</h2>
          <p>
            You agree to indemnify and hold us harmless from claims, losses, and reasonable costs
            arising out of your misuse of KIDS FUN or your breach of these Terms.
          </p>

          <h2>Ending your use</h2>
          <p>
            You can stop using KIDS FUN at any time, and delete your account from your Account page.
            The parts of these Terms that by their nature should outlast your use — the disclaimers,
            the limitation of liability, and the indemnity — continue to apply afterwards.
          </p>

          <h2>Changes to these Terms</h2>
          <p>
            We may update these Terms as KIDS FUN changes and as they go through legal review. When we
            do, the updated version is posted on this page and takes effect when it is posted.
            Continuing to use KIDS FUN after an update means you accept the updated Terms. If you do
            not agree with a change, please stop using the service.
          </p>

          <h2>Privacy</h2>
          <p>
            How we collect, use, and protect personal information is set out separately in our{' '}
            <a href="/privacy">Privacy Policy</a>, which forms part of these Terms. To be clear about
            what that means: the Privacy Policy is a finalised document that is in force in its own
            right. The draft status noted at the top of this page applies to these Terms, and does
            not extend to it.
          </p>

          <h2>Governing law</h2>
          <p>
            These Terms are governed by the laws of the Province of British Columbia and the federal
            laws of Canada that apply there, without regard to conflict-of-laws rules. The courts of
            British Columbia have jurisdiction, subject to any consumer-protection rights you have
            where you live.
          </p>

          <h2>General</h2>
          <p>
            If any part of these Terms is found to be unenforceable, the rest stays in effect. If we
            do not enforce something straight away, that is not a waiver of it. These Terms, together
            with the Privacy Policy, are the whole agreement between you and us about KIDS FUN.
          </p>

          <h2>Contact</h2>
          <p>
            Questions about these Terms? Email us at{' '}
            <strong>
              <a href="mailto:joncartwright00@gmail.com">joncartwright00@gmail.com</a>
            </strong>{' '}
            <em>(interim contact — this will move to a dedicated address once a domain is registered).</em>
          </p>
        </main>
      </div>
    </div>
  );
}
