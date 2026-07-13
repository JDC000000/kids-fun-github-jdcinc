// lib/search/expand.ts — G-T16-2: query-time alias expansion (TSD §5A.1,
// §5A.2 IR-07/UXR-02). Expands free text via synonym_alias AT QUERY TIME
// ONLY — never baked into listing vectors (0010_fts.sql), so an operator
// editing an alias changes results immediately with no re-index. G-T17-2
// (M5) wires the no-code CRUD write path; this is the read side every
// search request uses.
import { query } from '../db/client';

export interface AliasExpansion {
  canonicalCategoryKeys: string[];
  canonicalTagKeys: string[];
  synonymTerms: string[];
}

interface AliasRow {
  alias_text: string;
  category_key: string | null;
  tag_key: string | null;
}

const EMPTY: AliasExpansion = { canonicalCategoryKeys: [], canonicalTagKeys: [], synonymTerms: [] };

/** Looks up every synonym_alias row whose alias_text appears in freeText
 *  (substring match on already-lowercased text, per parseQuery). */
export async function expandAliases(freeText: string): Promise<AliasExpansion> {
  const text = freeText.toLowerCase().trim();
  if (!text) {
    return EMPTY;
  }

  const rows = await query<AliasRow>(
    `SELECT sa.alias_text, c.key AS category_key, t.key AS tag_key
     FROM synonym_alias sa
     LEFT JOIN category c ON c.id = sa.canonical_category_id
     LEFT JOIN tag t ON t.id = sa.canonical_tag_id`
  );

  const categoryKeys = new Set<string>();
  const tagKeys = new Set<string>();
  const synonymTerms = new Set<string>();

  for (const row of rows) {
    if (text.includes(row.alias_text.toLowerCase())) {
      if (row.category_key) categoryKeys.add(row.category_key);
      if (row.tag_key) tagKeys.add(row.tag_key);
      synonymTerms.add(row.alias_text);
    }
  }

  return {
    canonicalCategoryKeys: [...categoryKeys],
    canonicalTagKeys: [...tagKeys],
    synonymTerms: [...synonymTerms],
  };
}
