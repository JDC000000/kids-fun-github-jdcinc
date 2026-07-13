-- synonym_alias.sql — G-T17-1: seed parent-language alias dictionary
-- (TSD §5A.2 IR-07/UXR-02). Verbatim from the §5A.2 worked table — every
-- canonical category below has >=3 aliases (eval criterion). Query-time
-- expansion only (lib/search/expand.ts) — this table is never baked into
-- the search_tsv vector. Idempotent on lower(alias_text) (unique index in
-- 0005_taxonomy.sql).

INSERT INTO synonym_alias (alias_text, canonical_category_id)
SELECT v.alias, c.id
FROM (VALUES
  ('open gym',            'open_gym'),
  ('drop-in gym',         'open_gym'),
  ('family drop-in',      'open_gym'),
  ('gymnasium play',      'open_gym'),
  ('gym time',            'open_gym'),

  ('family swim',         'public_swim'),
  ('public swim',         'public_swim'),
  ('parent-child swim',   'public_swim'),
  ('leisure swim',        'public_swim'),
  ('everyone welcome swim','public_swim'),

  ('public skate',        'skate'),
  ('family skate',        'skate'),
  ('ice time',            'skate'),
  ('open skate',          'skate'),

  ('story time',          'storytime'),
  ('toddler storytime',   'storytime'),
  ('baby storytime',      'storytime'),
  ('family storytime',    'storytime'),

  ('mini train',          'miniature_train'),
  ('miniature railway',   'miniature_train'),
  ('model train ride',    'miniature_train'),

  ('toboggan',            'tobogganing'),
  ('tubing',               'tobogganing'),
  ('sliding',              'tobogganing'),
  ('snow tubing',         'tobogganing'),

  ('indoor playground',   'indoor_play'),
  ('play centre',         'indoor_play'),
  ('soft play',           'indoor_play')
) AS v(alias, cat_key)
JOIN category c ON c.key = v.cat_key
ON CONFLICT ((lower(alias_text))) DO NOTHING;
