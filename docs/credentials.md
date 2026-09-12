# KIDS FUN — Credential Registry (slug names only — NEVER values)

Source: TSD v1.2 §3A.1 (Secrets), §11 · scope-to-task v1.1 §C (G-T1-3).

All secrets live in the Control-Room Credential Vault (AES-256-GCM at rest) and are fetched
at runtime via `credentials-cli.js` / injected per-environment. **No secret value appears in
this repo, in `.env` files, in logs, or in chat.** This file records slugs and status only.

## Reused MyZone account credentials (already in vault)

| Purpose | Vault slug | Type | Notes |
|---|---|---|---|
| Vercel API token | `vercel` | api_key | Account jdc000000; provisions/deploys projects |
| Supabase org PAT | `supabase-management` | api_key | Creates projects in org `JDC000000's Org` |
| Fly.io deploy token | `fly-io` | api_key | `personal` org; worker deploy |
| GitHub PAT | `github` | api_key | Repo create / CI (if operator approves remote repo) |

## KIDS FUN-specific secrets — ALL PROVISIONED

> **Corrected 2026-09-12.** This section was headed *"placeholder connectors created; values
> pending"* and every row below read `placeholder`. That was false for **all six** — each slug
> was re-checked against the live vault on 2026-09-12 and holds a real value. The rows had not
> been updated after provisioning, so a doc written before Round 28 was still describing a
> pre-launch state months after production went live (see `docs/infra.md`, which was correct
> throughout).
>
> This mattered beyond tidiness: `lib/db/auth.ts` carried the same false claim, and the pair of
> them were read as evidence that Google sign-in "could not round-trip" and was therefore inert.
> It was in fact live on the production domain. Anyone judging blast radius from these two files
> would have got it badly wrong — which is exactly what nearly happened.
>
> **Verified status only. No values are recorded here or anywhere outside the vault.**

| Purpose | Vault slug | Type | Needed by | Status (verified 2026-09-12) |
|---|---|---|---|---|
| Supabase staging keys (URL/anon/service-role) | `kids-fun-supabase-staging` | multi_key | after project create | ✅ provisioned |
| Supabase prod keys (URL/anon/service-role) | `kids-fun-supabase-prod` | multi_key | after project create | ✅ provisioned |
| Google OAuth (client id/secret) | `kids-fun-google-oauth` | multi_key | G-T6-1 (M0 Wave 2) | ✅ provisioned — and the Google provider IS enabled in the Supabase prod project (its `/auth/v1/authorize?provider=google` redirects to `accounts.google.com` with a real client id). **The sign-in capability is nevertheless GATED OFF in the app** — see `lib/auth/google-signin-gate.ts`. Credentials live, route closed. |
| Resend API key | `kids-fun-resend` | api_key | M4 weekly email | ✅ provisioned |
| Mapbox / geocoding key | `kids-fun-mapbox` | api_key | G-T4-4 (M0 Wave 2) | ✅ provisioned |
| Sentry DSN + source-map upload token | `kids-fun-sentry` | multi_key | M6 (T37) | ✅ provisioned |

**If you are about to trust a `Status` cell in this table, re-check it.** The failure mode above
was not a wrong fact; it was a stale one that nobody re-read. Status can be confirmed without
ever revealing a value — `credentials-cli.js get <slug>` and look at whether a real value comes
back, never at what it is.

## How to populate a placeholder (secure — value never seen by the agent)

```bash
# Fires a secure inline form; the user types the value straight into the encrypted store.
REQ=/opt/projects/crhq-satellite/server/services/request-credential.js
node $REQ --slug kids-fun-mapbox --name "KIDS FUN Mapbox" --type api_key --provider mapbox.com
```

## Verify a slug is present (never echoes the value)

```bash
node /opt/projects/crhq-satellite/server/services/credentials-cli.js get <slug> >/dev/null \
  && echo "present" || echo "missing"
```
