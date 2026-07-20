# PIPEDA compliance checklist — KIDS FUN

**Scope-to-task:** G-T38-2 ("PIPEDA checklist for child ages + home postal; verify account deletion + analytics retention behave"), Round 23 / Task QQ.
**Date:** 2026-07-20 · **Base commit:** `38fdfa8f921dda434f0a227b71d97767ab2d9b61` (main).
**Author:** Developer Ops (docs-only task; no product code was modified).
**Law:** PIPEDA (Personal Information Protection and Electronic Documents Act, Canada) — the ten fair-information principles in Schedule 1 (CSA Model Code, cl. 4.1–4.10).

> **Status of this document.** This is an engineering assessment of the app's **actual current behaviour** against each PIPEDA principle, applied specifically to what KIDS FUN collects and does today — not a generic template and **not a legal opinion**. Where the app's behaviour is ambiguous against a principle, it is written up as a **numbered flagged finding (F-n)** for the product owner's (Jon's) judgment rather than silently graded pass/fail. The full flagged-findings write-up lives alongside this in the Round 23 / Task QQ findings doc. A definitive "are we compliant?" determination is a legal/product call, not an engineering one.

---

## 0. How this was verified

Assertions below marked **LIVE-VERIFIED** were exercised against a **real ephemeral PostGIS 16 / PostgreSQL 16.4** database (throwaway container, throwaway data only — no real user data touched), with the app's actual schema (all 18 forward migrations applied) and the app's own data-access modules driven through the RLS-enforcing `authenticated` connection, exactly as production does:

- The three genuinely DB-backed suites pass against real Postgres: `tests/account_data_export.test.ts` (4), `tests/account_deletion.test.ts` (4), `tests/analytics/retention.test.ts` (4), plus `tests/email/account_deletion_cascade.test.ts` (1) — **13/13 green**.
- A bespoke end-to-end probe created a throwaway account (postal `V6B 1A1`, child ages `[18, 42]` months, 2 saved searches, analytics rows keyed both to the pseudonymous user id and to an anon session), then ran the **real** `exportUserData` → `deleteUserData` → `purgeExpiredAnalyticsEvents` code paths and read the actual table state before/after. Results are cited inline. (The probe was throwaway and has been removed; it never lands in the repo.)

---

## 1. What the app actually collects (data inventory)

| Data | Where it lives (real schema/code) | Keyed to | Notes |
|---|---|---|---|
| **Child ages** (in months) | `user_profile.saved_child_ages integer[]` (`supabase/migrations/0007_user_admin.sql`) | Account (`auth.uid()`) | Optional; entered on `/account` (`AccountForm.tsx`). |
| **Home postal code** | `user_profile.home_postal text` (0007) | Account | Optional; `home_geo geography` derived point added in `0009_geo_columns.sql`. |
| **Email opt-in flag** | `user_profile.email_opt_in boolean` (0007, default `false`) | Account | Explicit unchecked-by-default checkbox. |
| **Email address** | Supabase `auth.users` (managed schema) **AND** `user_profile.google_identity` (0007) — the app persists a copy at first-login (`ensureUserProfile(userId, user.email)`) | Account | Held in **two** places; the copy in `google_identity` is functionally redundant (the weekly-email path re-resolves the address from `auth.users`). See Option C / F-9. |
| **Saved searches** | `saved_search.query_json jsonb` (0007) | Account | Query params a parent chose to save. |
| **Search / usage analytics** | `analytics_event` (`0006_provenance_ops.sql`): `event_type`, `search_context_json`, `result_summary_json`, `user_or_session`, `retained_until` | **Anon session cookie `kf_anon_id`** *or* the **pseudonymous account user id** (see F-4/F-5) | `search_context_json` stores the raw typed query (truncated 200 chars), sort, region chips, filter tokens, radius — **deliberately excludes near-me origin coordinates** (`lib/analytics/record.ts`). |
| **Correction reports** | `correction_report` (0006): `reporter`, `issue_type`, `note` (free-text), `archived_at` | Anon `kf_anon_id` | Parent-facing UI currently submits **no** free-text note (see Principle 4 / F-6). |
| **Admin audit log** | `admin_audit_log` (0007) | Admin user id | Operator actions only. |

**Identifiers.** `kf_anon_id` is a random UUID v4 (`lib/db/session.ts`) — pseudonymous, `httpOnly`, `SameSite=Lax`, ~13-month lifetime (`middleware.ts`). The account id mirrors `auth.uid()` — a pseudonymous UUID. The human-identifying value (email) lives in Supabase `auth.users` **and is also duplicated into `user_profile.google_identity`** — the app doesn't functionally need the copy (see Option C / F-9).

---

## 2. The ten principles, applied

### Principle 1 — Accountability (cl. 4.1)
- **What the app does:** Strong *technical* accountability — service-role server-side data access (`lib/db/client.ts`), owner-only RLS on user tables (`0013_rls_user.sql`), default-deny RLS + `REVOKE ALL` on all 18 public tables (`0018_public_tables_default_deny_rls.sql`), and Sentry PII redaction (`sentry.scrub.ts`).
- **Gap:** No **designated accountable individual**, no written privacy-management policy, and no published complaint/contact channel.
- **Assessment: PARTIAL → see F-7.**

### Principle 2 — Identifying Purposes (cl. 4.2)
- **What the app does:** Purposes are identified *inconsistently* at collection. Postal field hint: "Used to remember your area." Email opt-in label states its purpose ("occasional updates about new activities"). **The children's-ages field states no purpose at all** — only format + optionality ("Comma-separated, in months (24 = 2 years). Leave blank if you'd rather not say.", `AccountForm.tsx`).
- **Assessment: PARTIAL — purpose of collecting a child's age is not communicated at collection time → see F-2.** (No app-wide statement of purposes exists either → F-1.)

### Principle 3 — Consent (cl. 4.3)
- **What the app does:** Sign-in is Google OAuth (`app/auth/signin/route.ts`) → the only consent screen shown is **Google's own**, which covers Google's data sharing, not KIDS FUN's collection of child ages / postal / search history. Profile fields are opt-in (blank allowed); email digest is explicit opt-in (default off). There is **no KIDS-FUN-authored consent or privacy notice** at sign-in or at profile-data entry.
- **Assessment: PARTIAL → see F-3, F-1.** Knowledge-and-consent for the child-age/postal collection rests on thin/absent purpose copy.

### Principle 4 — Limiting Collection (cl. 4.4)
- **What the app does — GOOD:** Collection is genuinely minimised. Ages are stored as integers (months), not birthdates. Analytics deliberately **omit** near-me coordinates and never store name/email/note text (`lib/analytics/record.ts` "PRIVACY DISCIPLINE"). The parent-facing "Report wrong info" control (`app/preview/_components/ReportWrongInfo.tsx`) submits **only** the occurrence id + anon session — no free-text note, even though `correction_report.note` and the client helper *could* carry one.
- **Notable:** `saved_child_ages` is **collected but currently has no functional consumer** — verified it is not read by search, ranking, or the weekly-email digest; only displayed/edited on `/account` and returned in the export. Collecting a child's age (the app's most sensitive datum) with no present use leans against limiting-collection. See Option A1 / F-8.
- **Assessment: MEETS overall (analytics/corrections minimisation is strong), with the `saved_child_ages`-is-unused caveat above.** (Also: `search_context_json` stores the raw typed query, which a parent *could* type identifying text into — captured as product signal, not scrubbed; low risk, noted under F-6.)

### Principle 5 — Limiting Use, Disclosure, and Retention (cl. 4.5)
- **Use/disclosure:** No third-party disclosure of personal profile data; data is used for the stated product function. No ad/tracking SDKs found.
- **Retention — LIVE-VERIFIED:** `analytics_event` has a **real, enforced** retention sweep. `retained_until` is stamped at insert (`lib/analytics/config.ts`, default **395 days ≈ 13 months**), and `lib/analytics/retention.ts::purgeExpiredAnalyticsEvents` genuinely **DELETEs** expired rows (not soft-delete, not merely scheduled). Probe: 1 expired row → dry-run found 1 / deleted 0 → real run deleted 1; fresh rows untouched.
- **Gaps:** (a) `correction_report` has **no** retention/purge job — only a soft-delete `archived_at` — so it is retained indefinitely, asymmetric to analytics (F-6). (b) The retention windows are close but not identical across three places (DB default `13 months`, `ANALYTICS_RETENTION_DAYS=395`, cookie `400 days`) and are **not formally justified** anywhere (F-6). (c) Analytics rows keyed to the pseudonymous **account** id are not removed on account deletion (F-5).
- **Assessment: PARTIAL — analytics retention MEETS and is verified; correction-report retention + formal justification are GAPS → see F-5, F-6.**

### Principle 6 — Accuracy (cl. 4.6)
- **What the app does:** A signed-in parent can edit their postal, child ages, and opt-in at any time (`AccountForm.tsx` → `PATCH /api/me`), and delete individual saved searches. Data is self-maintained, minimising staleness.
- **Assessment: MEETS.**

### Principle 7 — Safeguards (cl. 4.7)
- **What the app does — GOOD:** Owner-only RLS (`0013`), default-deny RLS + `REVOKE ALL` on all public tables (`0018`, Round 20 security remediation), all app reads/writes via a server-side service pool that isn't exposed to the browser, `httpOnly`/`SameSite=Lax` cookies, and explicit Sentry PII redaction incl. a dedicated **postal-code mask** and stripping of cookies/auth headers/client IP (`sentry.scrub.ts`). A full security review shipped in Round 20 (`docs/security-review.md`).
- **Minor note:** the `kf_anon_id` cookie is not set with an explicit `secure` flag in code (relies on HTTPS-only hosting); low risk, not itself a PIPEDA gap.
- **Assessment: MEETS.**

### Principle 8 — Openness (cl. 4.8)
- **What the app does:** **Nothing published.** An app-wide search found **no** privacy policy, `/privacy` route, privacy notice, or footer link anywhere (`app/`, `components/`, `lib/`). Retention windows, purposes, who can access the data, and how to exercise access/deletion are undocumented for the user.
- **Assessment: GAP — the single most material finding → see F-1.**

### Principle 9 — Individual Access (cl. 4.9)
- **What the app does — LIVE-VERIFIED:** Genuine self-service export. `GET /api/account/export` → `exportUserData` returns a structured JSON of the caller's `profile` (postal, child ages, home_geo, email opt-in, timestamps) + `saved_searches`, RLS-scoped to owner-only. Probe confirmed: export contained postal `V6B 1A1`, ages `[18,42]`, 2 saved searches, and **no** analytics data section; it also carries an honest `manifest.excluded` naming what's left out and why.
- **Gap:** The export **excludes** `analytics_event` rows even where those rows are keyed to the account's pseudonymous user id (not just to the anon cookie) — i.e. some personal-linked data the org holds is not returned on access (F-4).
- **Assessment: PARTIAL — a real, working access mechanism (strong) with an interpretation gap on analytics scope → see F-4.**

**Deletion (supports access/erasure & withdrawal of consent) — LIVE-VERIFIED:** `POST /api/account/delete` (confirm-phrase gated) → `deleteUserData` hard-deletes `saved_search` then `user_profile` in one RLS-scoped transaction; `weekly_email_send` cascades. Probe: `{saved_searches_deleted:2, profile_deleted:1}`, profile + saved rows genuinely gone (0/0), post-delete export profile = `null`. **Caveats:** the Supabase Auth identity (the email) is only *best-effort* removed if `deleteAuthIdentity` is configured (`authIdentityAttempted:false` otherwise); and analytics rows keyed to the pseudonymous user id survive deletion (F-5).

### Principle 10 — Challenging Compliance (cl. 4.10)
- **What the app does:** No published channel for a privacy complaint or access request (no contact, no form, no policy naming a route). The "Report wrong info" control is for *data-accuracy* about listings, not privacy complaints.
- **Assessment: GAP → folded into F-1 / F-7.**

---

## 3. Risk-reduction architectural options (decision-ready — for Jon)

> Added at Jon's request (relayed via the operator): go beyond auditing the law in the abstract and evaluate **practical, architecture-specific** ways to *reduce* risk, with honest pros/cons per option. **‹L3›: these are options to react to, not decisions taken or code written.** Each is grounded in this app's *actual* consumers of the data (verified below), so the tradeoffs are real, not generic. Two facts discovered while scoping these drive the analysis: **(i) `saved_child_ages` is stored but has no functional consumer today** (not used by search/ranking/digest — verified), and **(ii) the parent's email is duplicated into `user_profile.google_identity`** even though the app re-resolves the address from `auth.users` when it actually needs it.

### Option A — Minimal-retention: don't persist what isn't earning its keep

The two profile fields have *very different* consumer profiles, so they get different answers — that difference is the whole point.

**A1 · `saved_child_ages` (child ages).** *Consumers today: none functional* — only `/account` display/edit and the export. Options: **(1)** stop persisting it until a feature actually consumes it (YAGNI); or **(2)** move it on-device to the localStorage pattern the app already ships for anonymous users (`app/search/_lib/anon-memory.ts`; the TSD literally specifies "anon child-ages in localStorage").
- **Pros (this app):** removes *persistent database storage of a child's age* — the single most sensitive datum here — at **near-zero current UX cost, because nothing uses it yet**. It drops out of breach blast-radius, subject-access exports, and the retention conversation entirely. Directly advances Principle 4 (limiting collection) and matches the app's own on-device precedent.
- **Cons (this app):** when a future *age-matching* feature lands (the field's ostensible purpose), it would need the age at query time — from a localStorage value or re-entry rather than a synced server profile, and cross-device continuity (phone ↔ laptop) is lost. On-device storage clears with site data. But every one of these costs is **deferred and hypothetical today** — there is no such consumer yet.
- **Net / flag for Jon:** strong candidate — high risk-reduction, ~zero current cost. Decision: is an age-matching feature imminent enough to justify persisting *now*, or defer persistence until that feature exists (and keep it on-device meanwhile)?

**A2 · `home_postal` / `home_geo` (home location).** *Consumers today: real* — (1) the signed-in "saved-location origin" that prefills the search near-me origin + a location chip (`app/search/page.tsx`, Task 29), so a signed-in parent needn't re-grant browser geolocation or retype their area; (2) the weekly-email digest's geo matching (`lib/email/weekly.ts` reads `home_postal`). Anonymous users already get near-me from **browser geolocation** with nothing stored.
- **Pros of not persisting:** removes a home location (coarse but identifying) from the DB.
- **Cons (this app):** (1) the digest is a **backend cron send** — there's no cookie/localStorage to read when it runs days later, so geo-matched digests for opted-in users would break (could fall back to region-only, a real quality drop). (2) The signed-in convenience origin — which works even where browser geolocation is denied/unavailable — would be lost; signed-in parents fall back to the anonymous geolocation path. (3) **Concretely, saved searches degrade:** a saved search created with the "use my saved location" option (`useSavedLocation` in the search state) resolves its near-me origin on **re-run** from the stored `home_postal` (Task 29 `savedOrigin: { postal }` → "within X km of {area}"). Without a persisted `home_postal`, those saved searches lose their origin on re-run — they'd silently drop to no-near-me, or force the parent to re-grant browser geolocation / retype their area each time. This is the exact "saved searches relying on a stored home_postal for near-me defaults" case: it is a real, user-visible regression, not hypothetical.
- **Net / flag for Jon:** weaker than A1 — `home_postal` *earns* its persistence via the digest. Realistic middle path: **persist `home_postal` only for users who opted into the weekly email** (`email_opt_in = true`); treat location as browser/session-derived for everyone else. Decision: accept that scoping, or keep status quo?

### Option B — Ephemeral / refreshing client storage instead of durable DB rows

The app **already does this** in two forms for anonymous users: (i) the `kf_anon_id` **cookie** itself — an `httpOnly`, `SameSite=Lax` value with a **rolling ~13-month expiry** (`middleware.ts`), i.e. exactly the "session-scoped / periodically-refreshing cookie" pattern this option asks about; and (ii) `anon-memory.ts`, which persists the last search **client-side only** in `localStorage` (`kf_last_search`), never a DB row, with a hard "never store raw coordinates" invariant and a *dismissible* resume prompt (never silent auto-apply, for shared-device safety). Option B is: extend those same, already-shipped mechanisms to signed-in **convenience** data instead of a permanent `user_profile` row — e.g. hold the field in a refreshing cookie/localStorage that lapses if the parent stops visiting, rather than a row that lives forever until deletion.
- **Good candidates (pure on-device convenience):** `saved_child_ages` (reinforces A1), last-search/resume state, and UI prefs — a session cookie with rolling expiry or localStorage, so it self-expires (retention "for free") and never enters an export or a breach.
- **Poor candidates (genuinely need server durability):** `saved_search` — the *explicit* "saved" contract; a parent expects these to persist and be there next time, so moving them on-device breaks the feature's promise and loses them on cache-clear. `email_opt_in` + digest inputs — the backend must act on them when the user isn't present. The account/identity row itself.
- **Pros (this app):** on-device data is outside breach blast-radius and outside the subject-access export the org must produce; rolling expiry enforces retention automatically; consistent with the app's existing privacy discipline.
- **Cons (this app):** device-local (no cross-device continuity; lost on new device / clear-site-data); shared-device leakage unless it stays the dismissible-suggestion pattern; useless for anything the backend must do unattended (the digest again); slightly more client code and a possible SSR flash.
- **Net / flag for Jon:** a good fit for the *convenience* fields (it operationalises Option A1), **not** for `saved_search` or digest inputs. Decision: which convenience fields to move on-device.

### Option C — Lean on Google/Supabase for the *identity layer*; store less identity-adjacent data yourself

**Precise scope: this covers only the identity/email layer — NOT the child-specific data.** Ages and postal are app-specific; Google does not hold them and they **cannot** be delegated to Google's compliance posture. So this option deliberately does *not* touch F-1..F-3 for that data. What it *does* touch:
- **The finding:** the app persists the parent's **email in `user_profile.google_identity`** at first login (`ensureUserProfile(userId, user.email)`) — a duplicate of Supabase `auth.users`. And the app already knows how to fetch the email from `auth.users` on demand (the weekly-email path resolves the recipient via the service-role admin API, **not** from `google_identity`). So the stored copy is **functionally redundant**.
- **The option:** stop persisting `google_identity` (or null it) and always resolve the email from the auth session / service-role when needed. The app's own tables then key everything to the pseudonymous `auth.uid` only; the human-identifying email lives **solely** in Supabase's auth layer — the party that already authenticates the user and carries that identity-layer compliance.
- **Pros (this app):** removes an email copy from the app's own schema → smaller PII footprint, one fewer place email can leak or go stale, and **one authoritative email location for deletion** instead of two. The app already proves it doesn't *need* the stored copy (it re-resolves for sends).
- **Cons (this app):** (1) the export currently surfaces `google_identity` as the user's email — if removed, the export should instead pull the email from the auth session at export time to keep satisfying access (small change, not a capability loss). (2) each email use pays an `auth.users` lookup rather than a local column read (negligible; already done for digests). (3) **It does not reduce exposure for ages/postal** — be precise. (4) It does **not** remove the `auth.users` email itself, so the F-5 best-effort-auth-delete concern still stands; this only stops *duplicating* it.
- **Net / flag for Jon:** clean, low-cost footprint reduction for the identity layer specifically. Decision: drop the `google_identity` email copy and resolve email on-demand from auth?

### How the options interact
A1 and C are the **highest-value / lowest-cost** moves (an unused sensitive field; a redundant email copy) and are largely independent — either can be taken alone. B is the *mechanism* that makes A1 concrete for convenience data. A2 and `saved_search` are the cases where persistence is **justified by a real consumer** (digest; the "saved" contract), so the honest recommendation-shaped-observation is: the strongest retention wins here are removing what nothing uses, not stripping the features that do. **All of this remains Jon's call — nothing here is implemented.**

---

## 4. Summary

| # | Principle | Assessment | Flagged finding |
|---|---|---|---|
| 1 | Accountability | Partial (strong tech, no policy/owner) | F-7 |
| 2 | Identifying Purposes | Partial (child-age purpose absent) | F-2, F-1 |
| 3 | Consent | Partial (Google-only consent) | F-3, F-1 |
| 4 | Limiting Collection | **Meets**, with the `saved_child_ages`-unused caveat | F-8 (F-6 caveat) |
| 5 | Limiting Use/Disclosure/**Retention** | Partial (analytics ✅ verified; correction-report ❌) | F-5, F-6 |
| 6 | Accuracy | **Meets** | — |
| 7 | Safeguards | **Meets** | — |
| 8 | Openness | **Gap** (no privacy policy at all) | F-1 |
| 9 | Individual Access | Partial (export works; analytics scope) | F-4 |
| 10 | Challenging Compliance | Gap (no complaint channel) | F-1, F-7 |

**Verified-working today:** self-service data **export** (Principle 9), self-service account **deletion** (Principle 9), and enforced **analytics retention** (Principle 5) all behave correctly against a real database — the three behaviours G-T38-2 asked to confirm.

**Material gaps flagged for the product owner:** no privacy policy / openness surface (F-1); child-age collection purpose not stated (F-2); consent rests on Google's screen only (F-3); export/deletion scope vs. account-keyed analytics (F-4/F-5); retention not applied to correction_report and not formally justified (F-6); no accountable individual / complaint channel (F-7); `saved_child_ages` collected but unused (F-8); email duplicated into `google_identity` (F-9).

**Risk-reduction options (§3, decision-ready for Jon):** A — don't persist what has no consumer (`saved_child_ages`, strong; `home_postal` only where the digest needs it, weaker); B — extend the existing on-device localStorage pattern to signed-in convenience data (not to `saved_search`/digest inputs); C — drop the redundant `google_identity` email copy and lean on Supabase/Google for the identity layer only.

*These gaps + options are documented for Jon's decision. Per the docs-only scope of this task, no product code was changed here.*
