// lib/search/__fixtures__/aliases.ts — Seed synonym/alias dictionary (G-T17-1, TSD §5A.2).
//
// Parent-language phrases → canonical category/tag. Every §5A.2 canonical has ≥3
// aliases (eval target). This fixture doubles as the seed contract for the future
// `synonym_alias` table; a DB resolver loads the same rows.

import type { AliasEntry } from '../expand';

export const ALIAS_SEED: AliasEntry[] = [
  // open_gym
  { aliasText: 'open gym', canonicalCategoryKey: 'open_gym' },
  { aliasText: 'drop-in gym', canonicalCategoryKey: 'open_gym' },
  { aliasText: 'family drop-in', canonicalCategoryKey: 'open_gym' },
  { aliasText: 'gymnasium play', canonicalCategoryKey: 'open_gym' },
  { aliasText: 'gym time', canonicalCategoryKey: 'open_gym' },
  // public_swim
  { aliasText: 'family swim', canonicalCategoryKey: 'public_swim' },
  { aliasText: 'public swim', canonicalCategoryKey: 'public_swim' },
  { aliasText: 'parent-child swim', canonicalCategoryKey: 'public_swim' },
  { aliasText: 'leisure swim', canonicalCategoryKey: 'public_swim' },
  { aliasText: 'everyone welcome swim', canonicalCategoryKey: 'public_swim' },
  // skate
  { aliasText: 'public skate', canonicalCategoryKey: 'skate' },
  { aliasText: 'family skate', canonicalCategoryKey: 'skate' },
  { aliasText: 'ice time', canonicalCategoryKey: 'skate' },
  { aliasText: 'open skate', canonicalCategoryKey: 'skate' },
  // storytime
  { aliasText: 'story time', canonicalCategoryKey: 'storytime' },
  { aliasText: 'toddler storytime', canonicalCategoryKey: 'storytime' },
  { aliasText: 'baby storytime', canonicalCategoryKey: 'storytime' },
  { aliasText: 'family storytime', canonicalCategoryKey: 'storytime' },
  // miniature_train
  { aliasText: 'mini train', canonicalCategoryKey: 'miniature_train' },
  { aliasText: 'miniature railway', canonicalCategoryKey: 'miniature_train' },
  { aliasText: 'model train ride', canonicalCategoryKey: 'miniature_train' },
  // tobogganing
  { aliasText: 'toboggan', canonicalCategoryKey: 'tobogganing' },
  { aliasText: 'tubing', canonicalCategoryKey: 'tobogganing' },
  { aliasText: 'sliding', canonicalCategoryKey: 'tobogganing' },
  { aliasText: 'snow tubing', canonicalCategoryKey: 'tobogganing' },
  // indoor_play
  { aliasText: 'indoor playground', canonicalCategoryKey: 'indoor_play' },
  { aliasText: 'play centre', canonicalCategoryKey: 'indoor_play' },
  { aliasText: 'soft play', canonicalCategoryKey: 'indoor_play' },
];
