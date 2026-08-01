-- sources.sql — G-T3-4: living source-registry skeleton (TSD §5, §7.2, §10).
-- One row per launch source family/municipality. terms_status stays 'pending'
-- here — this seed never production-enables a source (that happens per-adapter
-- at T7-6/T8-6/T9-4/T10-4/T11-4, gated on G-T5-6 + an explicit terms decision).
-- Idempotent upsert keyed on (family, name).

INSERT INTO source (family, name, authority_tier, ingestion_method, baseline_cadence, near_date_cadence)
VALUES
  -- Adapter A — ActiveNet / ActiveCommunities (family 1-3, P0). T7 confirming
  -- query 2026-07-30 (docs/source-register.md §6.2): the TERMS question cleared
  -- (D-9 — ACTIVE's official Activity Search API v2 is authorised), but all three
  -- tenants are EXCLUDED on DATA grounds and stay 'pending':
  --  • Vancouver Park Board — in the API ('ActiveNet CA') but syndication ceased
  --    ~2024-06: 2025 and 2026 both return ZERO activities; newest drop-in
  --    listing ends 2023-08-26. Stale, not ingestable.
  --  • Burnaby / West Vancouver — no municipal organization in the API at all;
  --    their 2026 records are private clubs/schools on 'AW Camps 3.0'.
  -- The rec-portal itself (anc.ca.apm.activecommunities.com) remains ToU-barred
  -- for automated access by any technique. Re-run the confirming query before
  -- ever enabling these.
  ('activenet',  'City of Vancouver ActiveNet',      'official', 'auto', '1 day', '1 hour'),
  ('activenet',  'City of Burnaby ActiveNet',         'official', 'auto', '1 day', '1 hour'),
  ('activenet',  'District of West Vancouver ActiveNet','official','auto','1 day', '1 hour'),
  -- Adapter F — PerfectMind / Xplor BookMe4 (family 1-3, P0)
  ('perfectmind','City of Richmond PerfectMind',      'official', 'auto', '1 day', '2 hours'),
  ('perfectmind','NVRC (North Vancouver) PerfectMind', 'official', 'auto', '1 day', '2 hours'),
  -- Adapter B — Library (family 7, P0)
  ('library_bibliocommons','Vancouver Public Library BiblioEvents','official','auto','1 day', NULL),
  ('library_bibliocommons','Richmond Public Library BiblioEvents', 'official','auto','1 day', NULL),
  ('library_communico',    'Coquitlam Public Library Communico',   'official','auto','1 day', NULL),
  -- NVDPL (North Vancouver District Public Library) — the library family's 4th tenant and
  -- its only `generic_rss` platform, added under decision record D-12 (2026-07-31).
  -- terms_status stays 'pending' here like every other row: D-12 is Jon's acceptance of the
  -- UNREADABLE-robots.txt risk (HTTP 403, Cloudflare managed challenge) for THIS SOURCE BY
  -- NAME, which unblocks building the adapter — it is not a promotion of this row, and it
  -- does not generalise to any other source. Enabling live ingestion is still an explicit
  -- out-of-band ops action. Its robots_status + override are recorded AFTER this insert
  -- (see the block below the ON CONFLICT). See docs/source-register.md §6.8.
  ('library_generic_rss',  'North Vancouver District Public Library Events RSS', 'official','auto','1 day', NULL),
  -- Adapter D — Venue (family 4-5, P0). Round 22 / Task LL terms review (see
  -- docs/source-register.md §2/§6 + worker/adapters/venue/config.ts):
  --  • H.R. MacMillan Space Centre — robots permits (Disallow /wp-admin/ only) +
  --    commercial-only ToS + schema.org openingHours → live-capable (open hours).
  --  • Vancouver Aquarium — vanaqua.org robots.txt is Akamai "Access Denied"
  --    (active bot-block) → EXCLUDED from live; fixture-only shape example.
  --  • Science World — robots allows all but WP REST is 401-restricted and its
  --    events listing is JS-only → no headless-free machine path; not launched.
  -- terms_status stays 'pending' for all — production enablement is an explicit
  -- out-of-band ops action gated on G-T5-6, never this seed.
  ('venue_html', 'Vancouver Aquarium',                 'official', 'semi', '1 day', NULL),
  ('venue_html', 'H.R. MacMillan Space Centre',        'official', 'semi', '1 day', NULL),
  ('venue_html', 'Science World',                      'official', 'semi', '1 day', NULL),
  -- Adapter E — Seasonal status watcher (family 6, P0 for season-state correctness)
  ('seasonal_watcher', 'Stanley Park Miniature Railway status page', 'official', 'semi', '7 days', '1 day'),
  ('seasonal_watcher', 'Burnaby Central Railway status page',        'official', 'semi', '7 days', '1 day'),
  ('seasonal_watcher', 'Cypress Mountain tubing/sliding status page','official', 'semi', '7 days', '1 day'),
  -- Adapter C — City calendars + organizer-scoped Eventbrite (family 10, P0/P1).
  -- T10 / G-T10-2 (2026-07-31): the Eventbrite connector is now BUILT
  -- (worker/adapters/eventbrite/) and provably organizer-scoped, but ZERO organizers are
  -- authorised, so this row stays a placeholder and resolves to NO adapter — deliberately,
  -- the same honest zero as Science World above. Eventbrite has no anonymous read path
  -- (every call needs an organizer's OAuth authorisation or private token) and KIDS FUN
  -- holds no Eventbrite credential. Its own anonymous area-wide search endpoint was
  -- retired in 2019/2020, so the broad query IR-03 forbids no longer exists to make.
  -- authority_tier 'partner', NOT 'editorial': an organizer describing their OWN event is
  -- first-party, so G-T10-3's editorial → manual_candidate gate correctly does not apply.
  -- Onboarding a real organizer is a DATA change — see docs/source-register.md §6.5.
  ('city_calendar',      'City of Vancouver events calendar', 'official', 'auto',    '1 day', NULL),
  ('eventbrite_organizer','Organizer-scoped Eventbrite (placeholder — none configured yet)', 'partner', 'partner', '1 day', NULL)
ON CONFLICT (family, name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- NVDPL robots.txt: the honest record (F-5, migration 0022_source_robots_override.sql).
--
-- `nvdpl.events.mylibrary.digital/robots.txt` answers HTTP 403 behind a Cloudflare managed
-- challenge. So the FACT is 'unknown' — we looked and could not determine — not 'pending'
-- (nobody has looked yet) and emphatically not 'allowed' (a human read it and it permits
-- us), which is what every other 'allowed' row on this project means. The AUTHORISATION to
-- proceed anyway is recorded separately, as the decision record that granted it.
--
-- THIS DOES NOT ENABLE NVDPL. terms_status is still 'pending', so both the per-run gate
-- (worker/core/terms-gate.ts) and the scheduler's SQL predicate (worker/scheduler/tiered.ts)
-- still refuse this row — on terms, before robots is even reached. Promoting terms_status to
-- 'summarise_only' remains the same deliberate out-of-band ops action it is for VPL, RPL and
-- the city calendar; this seed has never production-enabled a source and still doesn't.
--
-- Written as a GUARDED UPDATE rather than folded into the INSERT above, for two reasons:
--   • the INSERT is ON CONFLICT DO NOTHING, so on every database where the row already
--     exists (i.e. all of them, after the first seed run) an INSERT would set nothing; and
--   • the WHERE clause makes re-running non-destructive. If someone later reads a real
--     robots.txt for this host and sets 'allowed'/'disallowed', or records a DIFFERENT
--     decision, the next seed run leaves that alone instead of silently reverting a human's
--     finding back to "unreadable". Converging an untouched row is the job; overwriting a
--     deliberate correction is not.
UPDATE source
   SET robots_status            = 'unknown',
       robots_override_decision = 'D-12',
       robots_override_note     = 'robots.txt unreadable (HTTP 403, Cloudflare managed challenge). Risk accepted for THIS SOURCE ONLY by decision D-12; reasoning and scope live in docs/source-register.md §6.8 and §7 F-5. Does not generalise to any other source.'
 WHERE family = 'library_generic_rss'
   AND name   = 'North Vancouver District Public Library Events RSS'
   AND robots_status IN ('pending', 'unknown')
   AND (robots_override_decision IS NULL OR robots_override_decision = 'D-12');
