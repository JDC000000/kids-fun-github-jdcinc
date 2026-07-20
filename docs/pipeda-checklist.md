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
| **Email address** | Supabase `auth.users` (managed schema) — **not** in `user_profile` | Account | The app never copies the address into its own tables. |
| **Saved searches** | `saved_search.query_json jsonb` (0007) | Account | Query params a parent chose to save. |
| **Search / usage analytics** | `analytics_event` (`0006_provenance_ops.sql`): `event_type`, `search_context_json`, `result_summary_json`, `user_or_session`, `retained_until` | **Anon session cookie `kf_anon_id`** *or* the **pseudonymous account user id** (see F-4/F-5) | `search_context_json` stores the raw typed query (truncated 200 chars), sort, region chips, filter tokens, radius — **deliberately excludes near-me origin coordinates** (`lib/analytics/record.ts`). |
| **Correction reports** | `correction_report` (0006): `reporter`, `issue_type`, `note` (free-text), `archived_at` | Anon `kf_anon_id` | Parent-facing UI currently submits **no** free-text note (see Principle 4 / F-6). |
| **Admin audit log** | `admin_audit_log` (0007) | Admin user id | Operator actions only. |

**Identifiers.** `kf_anon_id` is a random UUID v4 (`lib/db/session.ts`) — pseudonymous, `httpOnly`, `SameSite=Lax`, ~13-month lifetime (`middleware.ts`). The account id mirrors `auth.uid()` — also a pseudonymous UUID; the human-identifying value (email) stays in Supabase `auth.users`.

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
- **Assessment: MEETS.** (One caveat: `search_context_json` stores the raw typed query, which a parent *could* type identifying text into — captured as product signal, not scrubbed; low risk, noted under F-6.)

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

## 3. Summary

| # | Principle | Assessment | Flagged finding |
|---|---|---|---|
| 1 | Accountability | Partial (strong tech, no policy/owner) | F-7 |
| 2 | Identifying Purposes | Partial (child-age purpose absent) | F-2, F-1 |
| 3 | Consent | Partial (Google-only consent) | F-3, F-1 |
| 4 | Limiting Collection | **Meets** | (F-6 caveat) |
| 5 | Limiting Use/Disclosure/**Retention** | Partial (analytics ✅ verified; correction-report ❌) | F-5, F-6 |
| 6 | Accuracy | **Meets** | — |
| 7 | Safeguards | **Meets** | — |
| 8 | Openness | **Gap** (no privacy policy at all) | F-1 |
| 9 | Individual Access | Partial (export works; analytics scope) | F-4 |
| 10 | Challenging Compliance | Gap (no complaint channel) | F-1, F-7 |

**Verified-working today:** self-service data **export** (Principle 9), self-service account **deletion** (Principle 9), and enforced **analytics retention** (Principle 5) all behave correctly against a real database — the three behaviours G-T38-2 asked to confirm.

**Material gaps flagged for the product owner:** no privacy policy / openness surface (F-1); child-age collection purpose not stated (F-2); consent rests on Google's screen only (F-3); export/deletion scope vs. account-keyed analytics (F-4/F-5); retention not applied to correction_report and not formally justified (F-6); no accountable individual / complaint channel (F-7).

*These gaps are documented for a future round to remediate. Per the docs-only scope of this task, no product code was changed here.*
