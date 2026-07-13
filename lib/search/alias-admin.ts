// lib/search/alias-admin.ts — Operator-editable alias CRUD hook (G-T17-2, FR-16, TSD §5A.2).
//
// No-code alias editing applied at QUERY TIME ONLY — no bulk re-index. This is the
// service seam the admin console (T34) wires to; it operates on a FixtureAliasResolver
// now and a DB-backed resolver later (both expose add/remove/list). Because the same
// resolver instance is read by the engine, an edit changes the very next search.

import type { AliasEntry, FixtureAliasResolver } from './expand';

export class AliasAdminService {
  constructor(private readonly resolver: FixtureAliasResolver) {}

  /** Add or update an alias (canonical category XOR tag). Effective immediately. */
  addAlias(entry: AliasEntry): void {
    if (!entry.aliasText?.trim()) throw new Error('aliasText required');
    if (!entry.canonicalCategoryKey && !entry.canonicalTagKey) {
      throw new Error('alias must map to a canonical category or tag');
    }
    if (entry.canonicalCategoryKey && entry.canonicalTagKey) {
      throw new Error('alias maps to exactly one canonical target, not both');
    }
    this.resolver.add(entry);
  }

  /** Remove an alias by its text. Effective immediately. */
  removeAlias(aliasText: string): void {
    this.resolver.remove(aliasText);
  }

  /** Current alias rows. */
  listAliases(): AliasEntry[] {
    return this.resolver.list();
  }
}
