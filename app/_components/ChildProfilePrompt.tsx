'use client';

// ChildProfilePrompt — the ask-once "who are you looking for" panel (design §5a / §9-Q7; U1).
//
// ═══ IT RENDERS ON /search. IT USED TO RENDER ON THE HOME PAGE, AND ONLY THERE. ═══
// COMMENT CORRECTED 2026-09-13 (TSD v1.2 T2.5). What follows used to read "HOME PAGE ONLY, by
// ruling (Jon 2026-08-19). Not on /search…", on the reasoning that the front door was the one
// surface with room to ask a question rather than interrupt a task. That ruling was about a page
// that no longer exists in that form: the home page is now the SMS front door (Delta 4 / AC-06
// removes this panel from it), so "home page only" would have meant "nowhere at all".
//
// It is on /search because that is where the answer is USED — `ProfileAgeDefault` consumes the
// profile there, and saving from here pushes `/search?age=…`, which takes effect on the screen
// the parent is already looking at. Keeping the panel home-page-only while removing it from the
// home page would have deleted the product's only profile-CAPTURE surface and silently stripped
// age personalisation from /search for every new visitor (Operator decision D-2, option (a)).
//
// NOTHING BELOW THIS COMMENT CHANGED. The behaviour is exactly what the 2026-08-19 ruling
// approved — an ask-once, dismissible panel that renders nothing once answered; only the surface
// it is mounted on moved, and it moved by a later ruling rather than by a quiet addition.
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
import { useRouter } from 'next/navigation';
import { sanitizeChildren, writeProfile, type ChildInput } from '@/lib/profile/child-profile';
import { childrenToAgeBands } from '@/lib/profile/child-age-bands';
import { hrefForParams } from '@/app/search/_lib/params';
import { ChildAgeForm } from './ChildAgeForm';
import { notifyChildProfileChanged, useChildProfile } from './useChildProfile';
import './child-profile.css';

/** Session-scoped "not now". Deliberately sessionStorage: it should not outlive the visit. */
const DISMISSED_KEY = 'kf_child_prompt_dismissed';

/**
 * Where "Show what fits" goes, or `null` for "stay on the front door".
 *
 * The button is labelled with a promise and until now it kept none of it: `save()` wrote the
 * profile, closed the panel, and left the parent on the same static home page they submitted
 * from. This is the whole of the destination decision, exported so it is testable without a DOM
 * — the same split `app/search/_lib/profile-default.ts` uses for the /search-side rule (policy in
 * a pure function, mechanics in the component).
 *
 * The ages are read from the SUBMITTED list, not back out of storage, so the filter the parent
 * asked for still lands when the write failed (private mode, quota, storage disabled). The URL is
 * the only thing /search needs — `writeProfile`'s success only decides whether the answer is
 * remembered NEXT visit. `sanitizeChildren` is the store's own normaliser, so the bands are
 * derived from exactly the entries that would have been persisted rather than a second reading
 * of the raw input.
 *
 * `hrefForParams({ age })` is byte-identical to what an Ages chip tap on a bare /search produces
 * (`hrefFor(DEFAULT_STATE, ageSelectionPatch(bands))` — every other param is at its default and
 * `pageParams` writes only non-defaults), so everything downstream reads this as an ordinary
 * parent-made selection: facets, the broadening ladder, analytics, the applied-filter token, and
 * `profileDefaultBands`'s rule 1, which correctly declines to re-apply a filter already in the URL.
 *
 * `null` — no band resolved from any child — falls back to today's behaviour (dismiss in place,
 * no navigation) rather than pushing a bare `/search`. `ChildAgeForm` validates before calling
 * back so this should be unreachable, but the carve-out mirrors `profileDefaultBands`'s: an
 * unreadable profile is not a reason to send a parent somewhere they did not ask to go.
 */
export function searchHrefForChildren(children: readonly ChildInput[]): string | null {
  const bands = childrenToAgeBands(sanitizeChildren(children));
  if (bands.length === 0) return null;
  return hrefForParams({ age: bands.join(',') });
}

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
  const router = useRouter();
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
    // …and then do what the button says. `push`, NOT `replace`: this is a destination the parent
    // chose by clicking a labelled control, so it belongs in their history — the opposite of
    // ProfileAgeDefault's bare-landing fill, which is a default nobody navigated to and uses
    // `replace` for exactly that reason.
    const href = searchHrefForChildren(children);
    if (href) router.push(href);
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
