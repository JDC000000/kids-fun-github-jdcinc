import { redirect } from 'next/navigation';
import { getRequestUser } from '@/lib/db/session-user';
import { ensureUserProfile, getUserProfile, type UserProfile } from '@/lib/db/user-profile';
import { AccountForm } from './_components/AccountForm';
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
  const user = await getRequestUser();
  if (!user) {
    // Reuse the existing OAuth initiation route; come back here after sign-in.
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

  const initial = {
    home_postal: profile?.home_postal ?? null,
    saved_child_ages: profile?.saved_child_ages ?? [],
    email_opt_in: profile?.email_opt_in ?? false,
  };

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

        <section className="kf-account-page__later" aria-label="Coming later">
          <h2 className="kf-account-page__later-title">Coming later</h2>
          <p>
            Saved searches, notification preferences, and downloading or deleting your data aren&apos;t
            here yet. For now you can update your saved area and children&apos;s ages above.
          </p>
        </section>
      </div>
    </main>
  );
}
