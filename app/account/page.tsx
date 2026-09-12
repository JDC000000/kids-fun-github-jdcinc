import { notFound, redirect } from 'next/navigation';
import { GOOGLE_SIGN_IN_ENABLED } from '@/lib/auth/google-signin-gate';
import { getRequestUser } from '@/lib/db/session-user';
import { ensureUserProfile, getUserProfile, type UserProfile } from '@/lib/db/user-profile';
import { listSavedSearches } from '@/lib/db/saved-search';
import { getServerSearchEngine } from '@/lib/search/server-engine';
import { runSavedSearch } from '@/lib/search/saved-search-status';
import { AccountForm } from './_components/AccountForm';
import { SavedSearches, type SavedSearchView, type SavedSearchEmptyView } from './_components/SavedSearches';
import { AccountData } from './_components/AccountData';
import './account.css';

// Parent-facing account page (Task 24, M4). A signed-in parent can see and edit
// their saved profile (home postal code, children's ages, email opt-in); an
// anonymous visitor is bounced to the existing Google sign-in, returning here
// afterward. This is a lower-visibility surface than /search or /preview, so it
// stays deliberately plain — civic field-guide tone (Manrope + the KIDS FUN
// palette), functional over fancy.
//
// Server component: it resolves the session and loads the profile server-side,
// then hands the current values to a small client form that PATCHes /api/me.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your account — KIDS FUN',
};

export default async function AccountPage() {
  // GATED (Jon, 2026-09-12): "nobody can sign in with google."
  //
  // This page's only route to an authenticated session was the Google OAuth flow, which is now
  // switched off (lib/auth/google-signin-gate.ts). Without that, `getRequestUser()` can never
  // return a user, so every line below this guard is unreachable and the redirect underneath it
  // would have sent anonymous visitors to a route that is itself now a 404 — a loop into nothing.
  // 404 here rather than that.
  //
  // ⚠ EVERYTHING BELOW IS INTENTIONALLY LEFT INTACT AND IS NOW UNREACHABLE. Whether this whole
  // area (profile, saved searches, the weekly-email opt-in, the data export and delete endpoints)
  // should be RETIRED is an open product question that Jon has not answered — it is flagged, not
  // decided here. Deleting it would also delete the PIPEDA export/delete endpoints, which is not
  // a call to make as a side effect of turning off a sign-in button.
  if (!GOOGLE_SIGN_IN_ENABLED) notFound();

  const user = await getRequestUser();
  if (!user) {
    // Unreachable while the gate above is closed. Kept for the re-enabled case.
    redirect('/auth/signin?next=/account');
  }

  // Load (self-healing) the profile. If the DB is unreachable we still render the
  // form with empty defaults and a gentle notice rather than erroring the page.
  let profile: UserProfile | null = null;
  let loadError = false;
  try {
    profile = await getUserProfile(user.userId);
    if (!profile) {
      profile = (await ensureUserProfile(user.userId, user.email)).profile;
    }
  } catch {
    loadError = true;
  }

  // saved_child_ages is intentionally NOT passed to the form: F-8 (Round 25 Task
  // WW) removed the children's-ages input, so the form no longer edits it. Any
  // legacy value still stored stays visible via the data export below.
  const initial = {
    home_postal: profile?.home_postal ?? null,
    email_opt_in: profile?.email_opt_in ?? false,
  };

  // Load the user's saved searches (owner-scoped via RLS). A DB hiccup just
  // renders an empty list — the "create" form below still works.
  let savedSearches: SavedSearchView[] = [];
  try {
    savedSearches = await listSavedSearches(user.userId);
  } catch {
    savedSearches = [];
  }

  // Which saved searches currently match NOTHING, and what is blocking each.
  //
  // Unconditional, and that is the point: the parent whose every saved search matches
  // nothing is precisely the parent who gets no weekly email, so an email can never be the
  // place they find out. Same evaluation the digest runs (runSavedSearch), so the two
  // surfaces cannot disagree.
  //
  // Best-effort: any failure — engine unavailable, one bad stored params blob — leaves the
  // row with no line at all. "We could not check" must never render as "nothing matches".
  const emptyById: Record<string, SavedSearchEmptyView> = {};
  if (savedSearches.length > 0) {
    try {
      const engine = await getServerSearchEngine();
      if (engine) {
        const now = new Date();
        for (const s of savedSearches) {
          try {
            const run = runSavedSearch(engine, s.params, profile?.home_postal ?? null, now);
            if (run.emptyState) emptyById[s.id] = { blockingLabel: run.emptyState.blockingLabel };
          } catch {
            // skip this row only
          }
        }
      }
    } catch {
      // leave the map empty — the list renders exactly as it did before.
    }
  }

  return (
    <main className="kf-account-page">
      <div className="kf-account-page__inner">
        <header className="kf-account-page__head">
          <p className="kf-account-page__eyebrow">Your account</p>
          <h1 className="kf-account-page__title">Profile &amp; preferences</h1>
          <p className="kf-account-page__signed">
            Signed in as <strong>{user.email ?? 'your Google account'}</strong>
          </p>
        </header>

        {loadError && (
          <p className="kf-account-page__notice" role="status">
            We couldn&apos;t load your saved profile just now. You can still make changes below —
            if saving fails, please try again in a moment.
          </p>
        )}

        <AccountForm initial={initial} />

        <SavedSearches initial={savedSearches} emptyById={emptyById} />

        <AccountData />

        <section className="kf-account-page__later" aria-label="Coming later">
          <h2 className="kf-account-page__later-title">Coming later</h2>
          <p>
            Notification preferences beyond the single email opt-in aren&apos;t here yet. For now you can
            manage your profile and saved searches, download a copy of your data, or delete your account
            above — and save a new search straight from the{' '}
            <a href="/search">search page</a>.
          </p>
        </section>
      </div>
    </main>
  );
}
