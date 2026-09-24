// app/admin/taxonomy/actions.ts — G-T34-4 server actions for the no-code taxonomy
// console (region / category / alias create + edit, alias delete). 'use server': these
// run only on the server and are the single write path the client forms post to.
//
// AUTH: every write is gated by resolveSessionAdmin() (Round-19 gate, reused) — a real
// signed-in admin only, never the interim read token (a write must be attributable in
// admin_audit_log, whose FK needs a real admin_user id). A token-only viewer sees a
// read-only console; each action re-checks here so the gate cannot be bypassed by
// posting a form directly.
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { resolveSessionAdmin } from '../_lib/gate';
import { bustCatalogueAfterAdminWrite } from '@/lib/search/catalogue-write-bust';
import {
  parseRegionInput,
  parseCategoryInput,
  parseAliasInput,
  type RegionFieldErrors,
  type CategoryFieldErrors,
  type AliasFieldErrors,
} from './_lib/vocab';
import {
  createRegion,
  updateRegion,
  getRegionById,
  RegionCycleError,
  createCategory,
  updateCategory,
  getCategoryById,
  createAlias,
  updateAlias,
  getAliasById,
  deleteAlias,
  TaxonomyConflictError,
} from './_lib/data';

export interface RegionActionState {
  ok?: boolean;
  message?: string;
  fieldErrors?: RegionFieldErrors;
}
export interface CategoryActionState {
  ok?: boolean;
  message?: string;
  fieldErrors?: CategoryFieldErrors;
}
export interface AliasActionState {
  ok?: boolean;
  message?: string;
  fieldErrors?: AliasFieldErrors;
}

const NEEDS_SESSION_ADMIN_MSG =
  'Making changes requires a signed-in admin account. The interim access token grants read-only access; ask an admin to be seeded, then sign in.';

function str(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v : '';
}

// ── Regions ───────────────────────────────────────────────────────────────────
export async function saveRegionAction(formData: FormData): Promise<RegionActionState> {
  const admin = await resolveSessionAdmin();
  if (!admin) return { ok: false, message: NEEDS_SESSION_ADMIN_MSG };

  const parsed = parseRegionInput({
    name: str(formData.get('name')),
    level: str(formData.get('level')),
    parentId: str(formData.get('parentId')),
  });
  if (!parsed.ok) return { ok: false, message: 'Please fix the highlighted fields.', fieldErrors: parsed.errors };

  const id = str(formData.get('id'));
  try {
    if (id) {
      const before = await getRegionById(id);
      if (!before) return { ok: false, message: 'That region no longer exists — reload the list.' };
      await updateRegion(id, parsed.value, admin.userId, before);
    } else {
      await createRegion(parsed.value, admin.userId);
    }
  } catch (err) {
    if (err instanceof RegionCycleError) {
      return { ok: false, message: 'A region cannot be its own parent or descendant.', fieldErrors: { parentId: 'This would create a parent → child loop.' } };
    }
    return { ok: false, message: 'Something went wrong saving the region. Nothing was changed.' };
  }

  revalidatePath('/admin/taxonomy');
  redirect(`/admin/taxonomy?flash=${id ? 'region-updated' : 'region-created'}`);
}

// ── Categories ──────────────────────────────────────────────────────────────
export async function saveCategoryAction(formData: FormData): Promise<CategoryActionState> {
  const admin = await resolveSessionAdmin();
  if (!admin) return { ok: false, message: NEEDS_SESSION_ADMIN_MSG };

  const parsed = parseCategoryInput({
    key: str(formData.get('key')),
    label: str(formData.get('label')),
    isPrimaryEligible: str(formData.get('isPrimaryEligible')),
  });
  if (!parsed.ok) return { ok: false, message: 'Please fix the highlighted fields.', fieldErrors: parsed.errors };

  const id = str(formData.get('id'));
  try {
    if (id) {
      const before = await getCategoryById(id);
      if (!before) return { ok: false, message: 'That category no longer exists — reload the list.' };
      await updateCategory(id, parsed.value, admin.userId, before);
    } else {
      await createCategory(parsed.value, admin.userId);
    }
  } catch (err) {
    if (err instanceof TaxonomyConflictError) {
      return { ok: false, message: 'A category with this key already exists.', fieldErrors: { key: 'This key is already in use.' } };
    }
    return { ok: false, message: 'Something went wrong saving the category. Nothing was changed.' };
  }

  // Only an UPDATE can change what listings show (category.key); regions and aliases have their own
  // short caches and never reach the catalogue snapshot. See lib/search/catalogue-write-bust.ts.
  if (id) await bustCatalogueAfterAdminWrite('category.update');
  revalidatePath('/admin/taxonomy');
  redirect(`/admin/taxonomy?flash=${id ? 'category-updated' : 'category-created'}`);
}

// ── Aliases ───────────────────────────────────────────────────────────────────
export async function saveAliasAction(formData: FormData): Promise<AliasActionState> {
  const admin = await resolveSessionAdmin();
  if (!admin) return { ok: false, message: NEEDS_SESSION_ADMIN_MSG };

  const parsed = parseAliasInput({
    aliasText: str(formData.get('aliasText')),
    target: str(formData.get('target')),
  });
  if (!parsed.ok) return { ok: false, message: 'Please fix the highlighted fields.', fieldErrors: parsed.errors };

  const id = str(formData.get('id'));
  try {
    if (id) {
      const before = await getAliasById(id);
      if (!before) return { ok: false, message: 'That alias no longer exists — reload the list.' };
      await updateAlias(id, parsed.value, admin.userId, before);
    } else {
      await createAlias(parsed.value, admin.userId);
    }
  } catch (err) {
    if (err instanceof TaxonomyConflictError) {
      return { ok: false, message: 'That alias phrase is already mapped.', fieldErrors: { aliasText: 'This alias phrase already exists (case-insensitive).' } };
    }
    return { ok: false, message: 'Something went wrong saving the alias. Nothing was changed.' };
  }

  revalidatePath('/admin/taxonomy');
  redirect(`/admin/taxonomy?flash=${id ? 'alias-updated' : 'alias-created'}`);
}

export async function deleteAliasAction(formData: FormData): Promise<AliasActionState> {
  const admin = await resolveSessionAdmin();
  if (!admin) return { ok: false, message: NEEDS_SESSION_ADMIN_MSG };

  const id = str(formData.get('id'));
  if (!id) return { ok: false, message: 'Missing alias id — reload the list.' };
  try {
    const before = await getAliasById(id);
    if (!before) return { ok: false, message: 'That alias no longer exists — reload the list.' };
    await deleteAlias(id, admin.userId, before);
  } catch {
    return { ok: false, message: 'Something went wrong deleting the alias. Nothing was changed.' };
  }

  revalidatePath('/admin/taxonomy');
  redirect('/admin/taxonomy?flash=alias-deleted');
}
