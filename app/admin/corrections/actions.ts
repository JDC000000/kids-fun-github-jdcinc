// app/admin/corrections/actions.ts — G-T34-7 server action: resolve one correction
// report. 'use server'. Gated by resolveSessionAdmin() (a write must be attributable in
// admin_audit_log; re-checked here so a direct POST cannot bypass the page gate).
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { resolveSessionAdmin } from '../_lib/gate';
import { bustCatalogueAfterAdminWrite } from '@/lib/search/catalogue-write-bust';
import { parseResolveInput, type ResolveFieldErrors } from './_lib/vocab';
import { resolveCorrection } from './_lib/data';

export interface ResolveActionState {
  ok?: boolean;
  message?: string;
  fieldErrors?: ResolveFieldErrors;
}

const NEEDS_SESSION_ADMIN: ResolveActionState = {
  ok: false,
  message:
    'Resolving a correction requires a signed-in admin account. Read-only access cannot make changes.',
};

/**
 * Resolve the correction report identified by the form's `reportId`, moving the
 * underlying occurrence to the chosen health state + confidence. Called directly by
 * the client ResolveForm inside a transition. On success: revalidate + redirect with a
 * flash; on failure: return a banner/field errors (no navigation).
 */
export async function resolveCorrectionAction(formData: FormData): Promise<ResolveActionState> {
  const admin = await resolveSessionAdmin();
  if (!admin) return NEEDS_SESSION_ADMIN;

  const reportId = str(formData.get('reportId'));
  if (!reportId) return { ok: false, message: 'Missing report id — reload the queue.' };

  const parsed = parseResolveInput({
    statusState: str(formData.get('statusState')),
    confidenceLabel: str(formData.get('confidenceLabel')),
    resolutionNote: str(formData.get('resolutionNote')),
  });
  if (!parsed.ok) {
    return { ok: false, message: 'Please fix the highlighted fields.', fieldErrors: parsed.errors };
  }

  let result;
  try {
    result = await resolveCorrection(reportId, parsed.value, admin.userId);
  } catch {
    return { ok: false, message: 'Could not resolve this report — check your selections and try again.' };
  }

  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === 'already_resolved'
          ? 'That report was already resolved by someone else.'
          : 'That report no longer exists — reload the queue.',
    };
  }

  await bustCatalogueAfterAdminWrite('correction.resolve');
  revalidatePath('/admin/corrections');
  redirect('/admin/corrections?flash=correction-resolved');
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v : '';
}
