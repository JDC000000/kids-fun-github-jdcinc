'use client';

// ChildProfilePrompt — the ask-once "who are you looking for" panel (design §5a / §9-Q7; U1).
//
// HOME PAGE ONLY, by ruling (Jon 2026-08-19). Not on /search, not on /preview, not as a header
// chip. The front door is the one surface with room to ask a question rather than interrupt a
// task, and a parent who arrives on a shared /search link is mid-errand — the design doc's own
// options list (§5a) treats a bar on /search as the "broader, more intrusive" variant, and it is
// not what was approved. If adoption turns out to need a second surface, that is a later
// iteration with its own decision, not a quiet addition here.
//
// STRUCTURALLY MODELLED ON ResumeSearch.tsx, which already solved this exact interaction for the
// other on-device store: an EXPLICIT, DISMISSIBLE suggestion, never a silent auto-apply, with the
// keep/dismiss controls visible and adjacent rather than buried. The parallel is not incidental —
// anon-memory.ts's header names this feature as its own origin (TSD Task 26, "anon child-ages in
// localStorage"), so the two are the same idea at two grains and should not look like two products.
//
// WHAT "ONCE" MEANS. Once per session, not once per forever:
//   • A profile exists  → never shown again, on any device where it exists. That is the real
//     stopping condition, and it is storage-backed.
//   • "Not now"         → hidden for the rest of this browser session (sessionStorage), and
//     offered again on a later visit. A parent who was in a hurry the first time has not said no
//     forever, and re-asking on the FRONT DOOR of a later visit is not nagging.
// The dismissal flag is a UX nicety, not a privacy mechanism — nothing about it is load-bearing,
// which is why it is one sessionStorage key with a try/catch and no versioned envelope. The
// PROFILE gets that treatment (lib/profile/child-profile.ts); a boolean about a panel does not.

import { useEffect, useState } from 'react';
import { writeProfile, type ChildInput } from '@/lib/profile/child-profile';
import { ChildAgeForm } from './ChildAgeForm';
import { notifyChildProfileChanged, useChildProfile } from './useChildProfile';
import './child-profile.css';

/** Session-scoped "not now". Deliberately sessionStorage: it should not outlive the visit. */
const DISMISSED_KEY = 'kf_child_prompt_dismissed';

function readDismissed(): boolean {
  try {
    return typeof window !== 'undefined' && window.sessionStorage?.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false; // storage blocked → the panel simply behaves as if never dismissed
  }
}

function rememberDismissed(): void {
  try {
    window.sessionStorage?.setItem(DISMISSED_KEY, '1');
  } catch {
    /* no-op — dismissal still holds for this render via component state */
  }
}

export function ChildProfilePrompt() {
  const { profile, ready } = useChildProfile();
  const [dismissed, setDismissed] = useState(true); // assume hidden until storage says otherwise

  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  const save = (children: ChildInput[]) => {
    // A failed write (private mode, quota, storage disabled) must not leave the panel sitting
    // there as if nothing happened, and must not claim success either. `writeProfile` never
    // throws and reports whether it stored anything; either way the parent has now answered the
    // question, so the panel closes for this session and the header bar picks the profile up if
    // there is one to pick up.
    writeProfile(children, Date.now());
    rememberDismissed();
    setDismissed(true);
    notifyChildProfileChanged('saved');
  };

  // `ready` gates the whole panel: before storage is read, "no profile" is not yet a fact, and
  // rendering on that assumption would flash the panel at every parent who already has one —
  // and would not match the server's HTML, which is a hydration error, not a cosmetic one.
  if (!ready || profile || dismissed) return null;

  return (
    <section className="kf-cprof kf-cprof--prompt" aria-labelledby="kf-cprof-prompt-title">
      <div className="kf-cprof__head">
        <p className="kf-cprof__eyebrow">Make this yours</p>
        <h2 className="kf-cprof__title" id="kf-cprof-prompt-title">
          Who are you looking for?
        </h2>
        <p className="kf-cprof__text">
          Tell us how old your kids are and we&apos;ll start with activities that fit them. Ages only — we never ask
          for names, and this stays on your device.
        </p>
      </div>

      <ChildAgeForm idPrefix="kf-cprof-prompt" submitLabel="Show what fits" onSubmit={save}>
        <button type="button" className="kf-cprof__btn" onClick={() => {
          rememberDismissed();
          setDismissed(true);
        }}>
          Not now
        </button>
      </ChildAgeForm>
    </section>
  );
}
