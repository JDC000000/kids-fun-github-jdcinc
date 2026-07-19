// app/admin/sources/actions.ts — G-T34-3 server actions for the no-code source
// registry (create + edit). 'use server': these run only on the server and are the
// single write path the client SourceForm posts to.
//
// AUTH: writes are gated by resolveSessionAdmin() — a real signed-in admin only, never
// the interim read token (a write must be attributable in admin_audit_log, whose FK
// needs a real admin_user id). A token-only viewer sees a read-only console; the action
// re-checks here so the gate cannot be bypassed by posting the form directly.
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { resolveSessionAdmin } from '../_lib/gate';
import { parseSourceInput, type SourceFieldErrors } from './_lib/vocab';
import { createSource, updateSource, getSourceById, SourceConflictError } from './_lib/data';

export interface SourceActionState {
  ok?: boolean;
  /** A top-level banner message (error or, on the no-JS path, could be success). */
  message?: string;
  /** Field-level validation messages, keyed by SourceInput field. */
  fieldErrors?: SourceFieldErrors;
}

const NEEDS_SESSION_ADMIN: SourceActionState = {
  ok: false,
  message:
    'Making changes requires a signed-in admin account. The interim access token grants read-only access; ask an admin to be seeded, then sign in.',
};

/**
 * Create (no `id`) or update (with `id`) a source row. The client SourceForm calls this
 * directly inside a transition, so it takes just the FormData and returns the next state.
 * On success it revalidates the list and redirects back with a `?flash=` marker (which
 * clears the form); on failure it returns field/banner errors and the browser keeps the
 * user's typed values (no navigation happens).
 */
export async function saveSourceAction(formData: FormData): Promise<SourceActionState> {
  const admin = await resolveSessionAdmin();
  if (!admin) return NEEDS_SESSION_ADMIN;

  const raw: Record<string, string> = {
    family: str(formData.get('family')),
    name: str(formData.get('name')),
    platform: str(formData.get('platform')),
    authorityTier: str(formData.get('authorityTier')),
    termsStatus: str(formData.get('termsStatus')),
    robotsStatus: str(formData.get('robotsStatus')),
    ingestionMethod: str(formData.get('ingestionMethod')),
    seasonState: str(formData.get('seasonState')),
    healthState: str(formData.get('healthState')),
    baselineCadence: str(formData.get('baselineCadence')),
    nearDateCadence: str(formData.get('nearDateCadence')),
  };

  const parsed = parseSourceInput(raw);
  if (!parsed.ok) {
    return { ok: false, message: 'Please fix the highlighted fields.', fieldErrors: parsed.errors };
  }

  const id = str(formData.get('id'));
  try {
    if (id) {
      const before = await getSourceById(id);
      if (!before) return { ok: false, message: 'That source no longer exists — reload the list.' };
      await updateSource(id, parsed.value, admin.userId, before);
    } else {
      await createSource(parsed.value, admin.userId);
    }
  } catch (err) {
    if (err instanceof SourceConflictError) {
      return {
        ok: false,
        message: 'A source with this family + name already exists.',
        fieldErrors: { name: 'This family + name combination is already registered.' },
      };
    }
    return { ok: false, message: 'Something went wrong saving the source. Nothing was changed.' };
  }

  revalidatePath('/admin/sources');
  redirect(`/admin/sources?flash=${id ? 'source-updated' : 'source-created'}`);
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v : '';
}
