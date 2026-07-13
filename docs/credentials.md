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

## KIDS FUN-specific secrets (placeholder connectors created; values pending)

| Purpose | Vault slug | Type | Needed by | Status |
|---|---|---|---|---|
| Supabase staging keys (URL/anon/service-role) | `kids-fun-supabase-staging` | multi_key | after project create | placeholder — fill post-provision |
| Supabase prod keys (URL/anon/service-role) | `kids-fun-supabase-prod` | multi_key | after project create | placeholder — fill post-provision |
| Google OAuth (client id/secret) | `kids-fun-google-oauth` | multi_key | G-T6-1 (M0 Wave 2) | placeholder — needs D-4 decision |
| Resend API key | `kids-fun-resend` | api_key | M4 weekly email | placeholder — request when due |
| Mapbox / geocoding key | `kids-fun-mapbox` | api_key | G-T4-4 (M0 Wave 2) | placeholder — request before G-T4-4 |
| Sentry DSN + source-map upload token | `kids-fun-sentry` | multi_key | M6 (T37) | placeholder — needs D-5 org/project |

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
