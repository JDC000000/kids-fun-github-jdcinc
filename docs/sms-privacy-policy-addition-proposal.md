# Proposed privacy-policy addition for the SMS product

> ## ⚠ DRAFT — NOT APPLIED, NOT REVIEWED, NOT APPROVED
>
> **Nothing in this file has been written into `app/privacy/page.tsx`.** That page is live, in
> production, and outside this branch's footprint — the SMS pivot branch has stayed in its own lane
> for nine rounds and this proposal does not change that.
>
> This is a **proposal for Jon and the Operator to review, amend and apply**, not a patch.
> Drafted 2026-08-26.

---

## Read this first: the change is not additive. There is a direct contradiction.

The task was framed as *"the privacy policy has no SMS section"*. It is worse than that. The live
policy currently states, verbatim:

> **We do not** collect children's ages, your name, precise location/GPS coordinates, payment
> information, or children's names. We do not use advertising or third-party tracking pixels.

**The SMS product collects children's approximate ages.** PRD §1.1 calls this out as the deliberate
policy reversal Jon authorised in writing. So adding a new section without amending that sentence
would leave `/privacy` **contradicting itself on the same page** — and the contradicted sentence is
the more prominent of the two, because it sits directly under the main "What we collect" table.

That makes this a **two-part change at minimum** (§A and §B below), not a bolt-on paragraph. Three
further sections go stale the moment the SMS product ships (§C–§E); they are separated out so the
required-vs-recommended split is visible rather than bundled.

---

## Process note — this page is not the source of truth

`app/privacy/page.tsx`'s own header says:

> The body text below is the FINAL, Jon-approved wording from
> `documents/requirements/jon-cartwright/kids-fun-privacy-policy-draft-v0.2-ready-for-launch.md`,
> copied **VERBATIM**. It is a signed-off artifact — do not paraphrase, summarise, reorganise, or
> "improve" it here. **Any factual correction belongs upstream in that document (and its
> approval), not in this page.**

So the correct route is: **amend the source document → re-approve → copy verbatim into the page.**
Editing the page directly would break the invariant that file exists to protect.

That source document is **not in this repository** (the path above does not resolve here), so I
could not check the proposed wording against it. Whoever applies this should work from the document
rather than from the rendered page.

---

# §A — REQUIRED: fix the contradiction

**Where:** the paragraph immediately below the "What we collect, and why" table
(`app/privacy/page.tsx` ~line 124).

**Current:**

> **We do not** collect children's ages, your name, precise location/GPS coordinates, payment
> information, or children's names. We do not use advertising or third-party tracking pixels.

**Proposed:**

> **We do not** collect your name, precise location/GPS coordinates, payment information, or
> children's names. We do not use advertising or third-party tracking pixels. If you sign up for
> our **weekly text messages**, we collect your children's **approximate ages** — see
> "Weekly text messages" below. We do not collect children's ages anywhere else.

*Why this shape:* it keeps the strong "we do not" list intact for everyone who never signs up for
texts, which is still the large majority, and confines the exception to the one product that has
it. The forward-reference means a reader who cares gets the detail without the caveat swallowing
the sentence.

---

# §B — REQUIRED: the new section (this is the main ask)

**Where:** a new `<h2>` **after** the existing `<h2>Anonymous usage data</h2>` section and
**before** `<h2>How we use your information</h2>` (~line 142).

*Why there:* the page's flow is *what we collect → collection details → how we use it → who we
share it with*. "Anonymous usage data" is already a collection-detail section, so SMS sits
naturally beside it, and the whole collection story is complete before the page moves on to use and
sharing. Placing it after "How we use your information" would mean the reader had already been told
how we use information before learning this category exists.

### Proposed copy

> ## Weekly text messages (SMS)
>
> The weekly text is a **separate, optional product** from the website. You can use KIDS FUN
> without it, and signing up for it is the only way we ever have your phone number.
>
> If you sign up, we collect and store:
>
> - **Your mobile number** — to send the weekly text, and as the only way we identify you. There is
>   no account and no password.
> - **Your postal code** — to find activities near you. We store the postal code itself, never a
>   precise location.
> - **Your children's approximate ages** — entered as a plain "how old are they now" number per
>   child. We store the **year** they were born, not a birthday, so the ages stay right as they grow
>   up. We never ask for a birthday, a month, or a child's name.
> - **The kinds of activity you're interested in** (optional) — the checkboxes you tick at signup or
>   on your preferences page.
>
> We use this information **only to choose the activities in that weekly text**. We do not use it
> for anything else.
>
> **Your mobile information — your phone number and everything above — is never sold, and never
> shared with advertisers or any other third party.** The only companies that ever see it are the
> service providers listed below who deliver the message on our behalf.
>
> Every message we send links to your own **preferences page**, where you can see everything we
> store about you, change your area, your children's ages or your interests, unsubscribe, or delete
> everything — with no login and no account. You can also reply **STOP** to any message to
> unsubscribe, or **HELP** to reach us.

### Cross-reference: this says the same thing as the consent checkbox

The task asked that the two documents cannot say two different things about the same practice. The
consent checkbox in `lib/sms/consent-copy.ts` (`CONSENT_CHECKBOX_TEXT`, version
`2026-08-26.v2`) reads:

> Yes, text me weekly activity picks. I agree that KIDS FUN can store **my phone number, my postal
> code and my children's approximate ages**, and **use them only to choose the activities in that
> weekly text**. This information is **never sold or shared with advertisers or any other third
> party**. I can **see, change or delete everything stored about me** at any time from my
> **preferences page**, which is linked in every message.

| Fact | Consent checkbox | Proposed policy wording |
|---|---|---|
| What is collected | "my phone number, my postal code and my children's approximate ages" | same three, itemised — **plus interests, see the flag below** |
| Purpose limitation | "use them only to choose the activities in that weekly text" | "**only to choose the activities in that weekly text**" — quoted exactly |
| Never sold/shared | "never sold or shared with advertisers or any other third party" | "**never sold, and never shared with advertisers or any other third party**" — same claim, expanded to name mobile information explicitly for CTIA |
| Access / correction / deletion | "see, change or delete everything stored about me … preferences page" | "see everything we store about you, change … unsubscribe, or delete everything" — same four capabilities |

**The CTIA requirement specifically** is that the privacy policy state mobile information is not
shared or sold to third parties. The bolded sentence in §B is that statement. It deliberately says
"mobile information" rather than only "your data", because that is the phrase the requirement uses.

### 🔴 Flag: the consent checkbox lists THREE items, the form collects FOUR

`CONSENT_CHECKBOX_TEXT` names the phone number, postal code and children's ages. It does **not**
mention **category interests**, which the signup form also collects (optionally) and stores in
`sms_consent.category_interests`.

PRD §1.3 itself enumerates only the three, so the checkbox matches the PRD — but the form collects
a fourth thing. The proposed policy wording above lists all four, because a privacy policy that
under-describes what is collected is the worse error.

**This is a real inconsistency between two approved artefacts and I have not silently resolved it.**
Two options, both cheap:

1. **Add interests to the consent checkbox** and bump `CONSENT_TEXT_VERSION` to `.v3`. Most
   consistent, and the checkbox is where consent is actually given.
2. **Leave the checkbox and rely on the policy** — defensible, since interests are optional,
   self-selected, and not sensitive. But the two documents then describe different collections.

I lean towards (1). It is one clause and one version bump, and the version-bump discipline exists
precisely so this kind of edit is deliberate.

---

# §C — REQUIRED: Twilio is missing from the service-provider list

**Where:** the `<ul>` under `<h2>Who we share it with (our service providers)</h2>` (~line 150).

This is a **PIPEDA disclosure gap, not just a CTIA one.** Twilio genuinely processes the phone
number and the message body on our behalf, and the current list — Google, Supabase, Resend, Sentry
— does not include it. The section's own closing sentence ("We do not otherwise disclose your
personal information to third parties") is inaccurate the day the first text is sent.

**Proposed list item**, matching the existing entries' shape:

> - **Twilio** — sends and receives the weekly text messages, **only if you signed up for them**
>   (receives your mobile number and the message content).

---

# §D — REQUIRED: SMS retention is not covered

**Where:** the `<ul>` under `<h2>How long we keep it</h2>` (~line 177).

The existing bullets cover account information, anonymous events and problem reports. None covers
SMS, and the SMS rules are materially different — they are time-based and automatic, which the
current list has no equivalent of except the 13-month analytics window.

**Proposed additional bullets**, from PRD §1.3:

> - **Your text-message details** (mobile number, postal code, children's ages, interests): kept
>   while you are subscribed, and **deleted 30 days after you unsubscribe.** If you use the "delete
>   my data" control on your preferences page, they are deleted straight away.
> - **A sign-up that is never confirmed:** if you sign up but never reply JOIN to our confirmation
>   text, everything we collected is **deleted after 90 days.**

> **Note for the reviewer:** the "deleted straight away" clause reflects the immediate-deletion
> behaviour implemented in round 8, which reads §1.3's *intent* (the 30-day grace exists to catch an
> accidental unsubscribe; an explicit confirmed delete request is not accidental) over its literal
> text. **That reading is itself still awaiting confirmation.** If it is reverted to the literal
> 30 days, delete this clause — the policy must not promise something the code does not do.

**Also worth stating here or in §B**, and currently stated nowhere: a **salted, one-way hash** of
the mobile number is retained indefinitely as the anti-spam (CASL) audit trail after the rest is
deleted. It cannot be used to contact anyone and is not reversible, but it is retained personal-
adjacent data and a policy that lists retention periods should not omit it. Suggested wording:

> After your details are deleted we keep a **scrambled, one-way code** derived from your mobile
> number — not the number itself, and not reversible — as the record that we were allowed to text
> you. Canadian anti-spam law requires us to be able to answer a complaint about a message we sent.

---

# §E — REQUIRED: the rights section assumes an account

**Where:** the `<ul>` under `<h2>Your choices and rights</h2>` (~line 202).

Every one of the four existing bullets routes the reader to **"your Account page"**. An SMS
subscriber **has no account** — that is the product's premise. As written, the policy tells them to
use a page they can never reach.

**Proposed:** append to each of the four existing bullets, or add one bullet covering all four:

> - **If you subscribe to the weekly text**, all four of these live on your **preferences page**
>   instead — the link in every message. No login. You can see everything we store, change your
>   area, children's ages and interests, unsubscribe, or delete everything.

---

# §F — Housekeeping the applier must not forget

1. **`EFFECTIVE_DATE` must be bumped.** It is `'2026-07-21'` today (`app/privacy/page.tsx` ~line
   27). The page's own "Changes to this policy" section promises *"we'll post the new effective date
   here"*, so leaving it would break a promise the page makes about itself.
2. **PRD §1.3 asks for "a dated changelog entry describing the reversal."** The page has **no
   changelog mechanism at all** — only a single effective date. Adding one is a structural change
   beyond this proposal's scope, and it is a real gap: a changed effective date tells a reader
   *that* something changed, not *what*. Flagged for a decision.
3. **The privacy contact stays as it is.** `/privacy` gives
   `joncartwright00@gmail.com` as the interim privacy contact. That is **not** the same thing as the
   SMS *support* contact (+1 877-835-7776) added in round 9 — one is for privacy concerns, the other
   for product questions. I have deliberately **not** merged them; conflating a privacy-rights
   channel with a support line would be a downgrade.

---

## What this proposal deliberately does NOT do

- **It does not touch `app/privacy/page.tsx`.** Not one character.
- **It does not invent facts.** Every claim traces to `lib/sms/consent-copy.ts`, PRD §1.1–§1.3, or
  migrations 0034/0035. Where a fact was missing (the source document, the changelog mechanism) it
  is flagged, not filled in.
- **It does not resolve the consent-checkbox/interests inconsistency** — that needs a decision and a
  version bump, and it is named in §B rather than quietly patched.
- **It is not legally reviewed.** I am not a lawyer and this text has not been near one. The CTIA
  requirement it addresses was verified against public sources in round 9; the PIPEDA framing mirrors
  wording already approved on this page rather than introducing new legal claims.
