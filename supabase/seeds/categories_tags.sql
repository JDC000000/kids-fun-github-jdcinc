-- categories_tags.sql — G-T3-3: category + tag reference seed (TSD §6.2 BR-09/10/12,
-- §5A.2 canonical category set). Idempotent upsert.

INSERT INTO category (key, label, is_primary_eligible) VALUES
  ('open_gym',      'Open Gym',                true),
  ('public_swim',   'Public / Family Swim',     true),
  ('skate',         'Public / Family Skate',    true),
  ('storytime',     'Storytime',                true),
  ('indoor_play',   'Indoor Play',              true),
  ('museum_venue',  'Museum / Cultural Venue',  true),
  ('attraction',    'Attraction',               true),
  ('festival_event','Festival / One-off Event', true),
  ('outdoor_park',  'Parks / Nature / Farms',   true),
  ('class_program',  'Class / Program',          true),
  -- secondary-only (not eligible as a listing's primary category)
  ('miniature_train','Miniature Train',         false),
  ('tobogganing',    'Tobogganing / Tubing',    false)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  is_primary_eligible = EXCLUDED.is_primary_eligible;

INSERT INTO tag (key, label, tag_type) VALUES
  ('drop_in',        'Drop-in',              'suitability'),
  ('free',           'Free',                 'suitability'),
  ('indoor',         'Indoor',               'suitability'),
  ('outdoor',        'Outdoor',              'suitability'),
  ('stroller_friendly','Stroller Friendly',  'suitability'),
  ('accessible',     'Accessible',           'suitability'),
  ('bookable_now',   'Bookable Now',         'status'),
  ('rainy_day',      'Rainy-day',            'context'),
  ('seasonal',       'Seasonal',             'context'),
  ('candidate_lead', 'Candidate Lead (unverified)', 'status')
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  tag_type = EXCLUDED.tag_type;
