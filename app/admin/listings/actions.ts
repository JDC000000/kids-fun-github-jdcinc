// app/admin/listings/actions.ts — G-T34-3 server action: create a manual listing.
// 'use server'. Gated by resolveSessionAdmin() (write must be audited → session admin
// only, re-checked here).
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { resolveSessionAdmin } from '../_lib/gate';
import { bustCatalogueAfterAdminWrite } from '@/lib/search/catalogue-write-bust';
import { parseManualListingInput, type ManualListingFieldErrors } from './_lib/vocab';
import { createManualListing, ManualListingError } from './_lib/data';

export interface ManualListingActionState {
  ok?: boolean;
  message?: string;
  fieldErrors?: ManualListingFieldErrors;
}

const NEEDS_SESSION_ADMIN: ManualListingActionState = {
  ok: false,
  message:
    'Adding a listing requires a signed-in admin account. Read-only access cannot make changes.',
};

/** Create a manual listing. Called directly by the client form inside a transition. */
export async function createManualListingAction(formData: FormData): Promise<ManualListingActionState> {
  const admin = await resolveSessionAdmin();
  if (!admin) return NEEDS_SESSION_ADMIN;

  const parsed = parseManualListingInput({
    title: str(formData.get('title')),
    sourceId: str(formData.get('sourceId')),
    venueName: str(formData.get('venueName')),
    venueAddress: str(formData.get('venueAddress')),
    displayArea: str(formData.get('displayArea')),
    venueLat: str(formData.get('venueLat')),
    venueLng: str(formData.get('venueLng')),
    startDatetimeUtc: str(formData.get('startDatetimeUtc')),
    endDatetimeUtc: str(formData.get('endDatetimeUtc')),
    openHoursState: str(formData.get('openHoursState')),
    costStatus: str(formData.get('costStatus')),
    costMinCad: str(formData.get('costMinCad')),
    costMaxCad: str(formData.get('costMaxCad')),
    sourceUrl: str(formData.get('sourceUrl')),
    bookingUrl: str(formData.get('bookingUrl')),
    locationUrl: str(formData.get('locationUrl')),
    descriptionSnippet: str(formData.get('descriptionSnippet')),
    statusState: str(formData.get('statusState')),
    confidenceLabel: str(formData.get('confidenceLabel')),
  });
  if (!parsed.ok) {
    return { ok: false, message: 'Please fix the highlighted fields.', fieldErrors: parsed.errors };
  }

  let result;
  try {
    result = await createManualListing(parsed.value, admin.userId);
  } catch (err) {
    if (err instanceof ManualListingError) return { ok: false, message: err.message };
    return { ok: false, message: 'Something went wrong saving the listing. Nothing was created.' };
  }

  await bustCatalogueAfterAdminWrite('listing.create');
  revalidatePath('/admin/listings/new');
  redirect(`/admin/listings/new?flash=listing-created&id=${result.occurrenceId}`);
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v : '';
}
