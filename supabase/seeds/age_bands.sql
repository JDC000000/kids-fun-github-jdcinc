-- age_bands.sql — G-T3-1: non-overlapping age bands (TSD §6.2 BR-01/02).
-- lower-inclusive / upper-exclusive months; 15+ is open-ended (upper = NULL).
-- Idempotent: safe to re-run (seeds are upserted, not versioned like migrations).

INSERT INTO age_band (key, lower_months_inclusive, upper_months_exclusive) VALUES
  ('under2', 0,   24),
  ('2-4',    24,  60),
  ('5-9',    60,  120),
  ('10-14',  120, 180),
  ('15+',    180, NULL)
ON CONFLICT (key) DO UPDATE SET
  lower_months_inclusive = EXCLUDED.lower_months_inclusive,
  upper_months_exclusive = EXCLUDED.upper_months_exclusive;
