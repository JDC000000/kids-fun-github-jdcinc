// lib/search/expand.ts — Query-time synonym/alias expansion (G-T16-2, TSD §5A.2).
//
// The "parent language" contract: map free-text phrases → canonical categories/tags
// + sibling synonym phrases, applied AT QUERY TIME ONLY. Alias text is never baked
// into listing vectors, so operator edits (FR-16, no-code) take effect immediately
// with no bulk re-index. `AliasResolver` is the swap seam: fixture now, DB (synonym_alias)
// later — same interface. See alias-admin.ts for the operator-editable mutation path.

import { normalize } from './text/normalize';

/** One row of the `synonym_alias` table (TSD §6.1). Exactly one canonical target. */
export interface AliasEntry {
  aliasText: string;
  canonicalCategoryKey?: string;
  canonicalTagKey?: string;
}

/** Result of expanding a term list at query time. */
export interface ExpandedQuery {
  /** Residual free-text terms not consumed by an alias phrase (each OR-ed into the matcher). */
  originalTerms: string[];
  /** Canonical category keys resolved from aliases (feed category boost + OR terms). */
  canonicalCategoryKeys: string[];
  /** Canonical tag keys resolved from aliases. */
  canonicalTagKeys: string[];
  /**
   * Sibling alias phrases + canonical keys as token arrays. Each is a PHRASE matched
   * with AND semantics (all tokens present), mirroring `tsquery(a b | c d)` — so
   * "family drop-in" does not leak into "Family Public Swim".
   */
  synonymPhrases: string[][];
  /** Alias phrases that matched (for explainability / analytics). */
  matchedAliases: string[];
}

/** Query-time alias expansion contract. */
export interface AliasResolver {
  expand(terms: string[]): ExpandedQuery;
}

/**
 * Fixture/in-memory alias resolver. Also the operator-editable store: the alias-admin
 * hook (G-T17-2) mutates this list and the very next `expand()` reflects it — proving
 * "edits take effect without re-index" (IR-07/UXR-02). A DB resolver implements the
 * same interface over `synonym_alias`.
 */
export class FixtureAliasResolver implements AliasResolver {
  private entries: AliasEntry[] = [];
  // phrase (normalised) → entry
  private byPhrase = new Map<string, AliasEntry>();
  // canonical category/tag key → all sibling alias phrases (normalised)
  private siblings = new Map<string, Set<string>>();

  constructor(entries: AliasEntry[] = []) {
    entries.forEach((e) => this.add(e));
  }

  /** Add/replace an alias (operator edit). Query-time only — no re-index. */
  add(entry: AliasEntry): void {
    const phrase = normalize(entry.aliasText);
    if (!phrase) return;
    const normalized: AliasEntry = { ...entry, aliasText: phrase };
    if (!this.byPhrase.has(phrase)) this.entries.push(normalized);
    this.byPhrase.set(phrase, normalized);
    const key = entry.canonicalCategoryKey ?? entry.canonicalTagKey;
    if (key) {
      if (!this.siblings.has(key)) this.siblings.set(key, new Set());
      this.siblings.get(key)!.add(phrase);
    }
  }

  /** Remove an alias by its text (operator edit). */
  remove(aliasText: string): void {
    const phrase = normalize(aliasText);
    const entry = this.byPhrase.get(phrase);
    if (!entry) return;
    this.byPhrase.delete(phrase);
    this.entries = this.entries.filter((e) => e.aliasText !== phrase);
    const key = entry.canonicalCategoryKey ?? entry.canonicalTagKey;
    if (key) this.siblings.get(key)?.delete(phrase);
  }

  /** Current alias rows (snapshot). */
  list(): AliasEntry[] {
    return [...this.entries];
  }

  expand(terms: string[]): ExpandedQuery {
    const consumed = new Array<boolean>(terms.length).fill(false);
    const categoryKeys = new Set<string>();
    const tagKeys = new Set<string>();
    const matched: string[] = [];

    // Greedy longest-phrase-first match over contiguous token windows.
    const phrases = [...this.byPhrase.keys()].sort(
      (a, b) => b.split(' ').length - a.split(' ').length || b.length - a.length,
    );
    for (const phrase of phrases) {
      const words = phrase.split(' ');
      for (let i = 0; i + words.length <= terms.length; i++) {
        if (consumed[i]) continue;
        let hit = true;
        for (let j = 0; j < words.length; j++) {
          if (terms[i + j] !== words[j]) { hit = false; break; }
        }
        if (!hit) continue;
        const entry = this.byPhrase.get(phrase)!;
        if (entry.canonicalCategoryKey) categoryKeys.add(entry.canonicalCategoryKey);
        if (entry.canonicalTagKey) tagKeys.add(entry.canonicalTagKey);
        matched.push(phrase);
        for (let j = 0; j < words.length; j++) consumed[i + j] = true;
      }
    }

    // Synonym phrases = canonical-key tokens + sibling alias phrases (each AND-matched).
    const synonymPhrases: string[][] = [];
    const seen = new Set<string>();
    const addPhrase = (tokens: string[]) => {
      const clean = tokens.filter(Boolean);
      const key = clean.join(' ');
      if (clean.length && !seen.has(key)) {
        seen.add(key);
        synonymPhrases.push(clean);
      }
    };
    for (const key of [...categoryKeys, ...tagKeys]) {
      addPhrase(key.split(/[_\s]+/));
      for (const sib of this.siblings.get(key) ?? []) addPhrase(sib.split(' '));
    }

    const originalTerms = terms.filter((_, i) => !consumed[i]);
    return {
      originalTerms,
      canonicalCategoryKeys: [...categoryKeys],
      canonicalTagKeys: [...tagKeys],
      synonymPhrases,
      matchedAliases: matched,
    };
  }
}
