// lib/admin/personal-data.ts — the one definition of "may this admin see personal data?" as the
// admin read models consume it, and the one string a redacted cell shows.
//
// The ROLE decision lives in lib/db/admin-guard.ts (canSeePersonalData). This module is what the
// read models take: an explicit, REQUIRED option — no default — so every caller decides from the
// signed-in admin's role rather than inheriting whatever a future edit leaves as the default.
// Anything other than an explicit `false` redacts (fail closed).
//
// Where each surface redacts:
//   · IN SQL — /admin/sms-subscribers (+ detail), /admin/sms-engagement, /admin/corrections: the
//     personal columns come back NULL, so the values never leave the database.
//   · AT THE PAGE, BEFORE RENDER — the recent-corrections list on /admin/dashboard and
//     /admin/data-health. The dashboard's payload is a precomputed, role-independent snapshot
//     (lib/admin/snapshot.ts), so there is no per-role query to redact in; both pages pass the list
//     through correctionsForDisplay (lib/admin/dashboard.ts) before anything renders it.

export interface PersonalDataOptions {
  redactPersonalData: boolean;
}

/** Fail-closed reading of the option: only an explicit `false` shows personal data. */
export function shouldRedact(opts: PersonalDataOptions): boolean {
  return opts.redactPersonalData !== false;
}

/** What a redacted personal cell says. One string, so every surface says it the same way. */
export const REDACTED_TEXT = 'redacted (read-only role)';
