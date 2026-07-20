-- sources.sql — G-T3-4: living source-registry skeleton (TSD §5, §7.2, §10).
-- One row per launch source family/municipality. terms_status stays 'pending'
-- here — this seed never production-enables a source (that happens per-adapter
-- at T7-6/T8-6/T9-4/T10-4/T11-4, gated on G-T5-6 + an explicit terms decision).
-- Idempotent upsert keyed on (family, name).

INSERT INTO source (family, name, authority_tier, ingestion_method, baseline_cadence, near_date_cadence)
VALUES
  -- Adapter A — ActiveNet / ActiveCommunities (family 1-3, P0)
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
  -- Adapter C — City calendars + organizer-scoped Eventbrite (family 10, P0/P1)
  ('city_calendar',      'City of Vancouver events calendar', 'official', 'auto',    '1 day', NULL),
  ('eventbrite_organizer','Organizer-scoped Eventbrite (placeholder — none configured yet)', 'partner', 'partner', '1 day', NULL)
ON CONFLICT (family, name) DO NOTHING;
