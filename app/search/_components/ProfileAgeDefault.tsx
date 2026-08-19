'use client';

// ProfileAgeDefault — the piece that ties the on-device child profile to what /search actually
// shows: on a bare landing it MATERIALISES the parent's children's ages into the URL as an
// ordinary `age=` selection (design §5c option 2a, Q3, ruled 2026-08-19), and it says on the page
// where that filter came from.
//
// ─── WHY A CLIENT-SIDE REDIRECT, AND WHAT IT COSTS ───────────────────────────────────────
// /search is `force-dynamic` and server-rendered from `searchParams`; localStorage is not
// readable on a server. Of the two mechanisms that leaves (design §4b), this is the one that was
// approved: render, read storage, `router.replace` to the filtered URL. The declined alternative
// — post-filtering cards after render — would desynchronise the list from the counts, the facets,
// the broadening notice and the `ageUnconfirmed` section, all computed server-side, and would
// make QuerySummary state a number that is not true.
//
// The cost is a FLASH of unfiltered results on a cold bare landing, and it is accepted rather
// than mitigated (design §4b option 1). The cookie mirror that would remove it (§4c option C)
// puts "this browser is shopping for a 2-4 and a 5-9" into a header on every request, beside a
// stable per-browser id, in every access log — which is the exposure the client-side-only posture
// was approved to avoid. A flash is a worse page; a cookie is a worse promise.
//
// `replace`, NOT `push`: this is a default being applied, not a destination the parent chose, and
// a back button that has to be pressed twice to leave a page nobody navigated to is the standing
// complaint against exactly this pattern. The URL that lands is byte-identical to the one a chip
// tap produces (`hrefFor` + `ageSelectionPatch`), so everything downstream — facets, the
// broadening ladder, analytics, saved searches, the applied-filter token, the composed `q` phrase
// AND the structured `age=` param the API gets (design §2b's "must feed both channels") — is fed
// by the one path it already had. That is the whole reason materialising beats injecting.
//
// ─── SCOPE: /search AND NOTHING ELSE ─────────────────────────────────────────────────────
// The design lists four surfaces that "age-filter everything by default" would touch (§8a). This
// is one of them. `HomeTodayStrip` is explicitly flagged as colliding with the answer-before-
// search initiative ("coordinate before touching this", §8c), /preview runs a separate client
// filter in a different vocabulary, and whether the public `/api/search` honours a profile is its
// own decision (§8a row 4 / R3). None of those is changed here, and adding them later is a
// decision, not a follow-up.
//
// ─── THE PRECEDENCE RULES ARE NOT IN THIS FILE ───────────────────────────────────────────
// `../_lib/profile-default.ts` owns them, and its header is where they are argued. This component
// owns only the mechanics: read, decide, navigate, explain.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { readProfile } from '@/lib/profile/child-profile';
import { childrenToAgeBands } from '@/lib/profile/child-age-bands';
import { describeChildAges } from '@/lib/profile/child-age-display';
import { subscribeChildProfileChanged, useChildProfile } from '../../_components/useChildProfile';
import { ageSelectionPatch, hrefFor, type SearchState } from '../_lib/params';
import { profileDefaultBands, sameBands } from '../_lib/profile-default';

export function ProfileAgeDefault({ state }: { state: SearchState }) {
  const router = useRouter();
  const { profile } = useChildProfile();
  // Did THIS component apply the default, in this session, on this page? The note below is a
  // claim about provenance, and provenance is not recoverable from the URL — that is the point of
  // materialising (a shared link must behave identically for whoever opens it). So the only
  // honest source for the claim is having done it, and a parent who arrives on a link someone
  // else shared correctly sees no note.
  const [applied, setApplied] = useState(false);
  // The current URL as a stable primitive, so the effects re-run when the SEARCH changes rather
  // than on every render (`state` is a fresh object from the server each time).
  const stateHref = hrefFor(state);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── The default fill. Runs on mount and after every navigation; does nothing unless the URL
  //    is genuinely silent about age (profileDefaultBands' rules 1-3).
  useEffect(() => {
    const bands = profileDefaultBands(state, profile);
    if (!bands) return;
    setApplied(true);
    router.replace(hrefFor(state, ageSelectionPatch(bands)));
    // `state` is captured through stateHref, which changes exactly when the URL does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, stateHref, router]);

  // ── An edit made HERE, now. Saving the profile in the header bar while standing on /search is
  //    an explicit statement by the parent in this session, not stored state filling a vacuum, so
  //    it is allowed to overwrite an age selection that is already in the URL — including
  //    `age=any`, which it supersedes for the same reason a chip tap would. This is the one place
  //    the "URL always wins" rule is not the whole story, and the distinction it turns on is
  //    live-action-versus-storage, which is the same line ResumeSearch draws.
  //
  //    'cleared' is deliberately NOT handled: forgetting the profile leaves the age filter where
  //    it is, in the URL, visible, with a "✕" on it. Silently widening the results as a side
  //    effect of a privacy action would be a second surprise stacked on the one that was asked for.
  useEffect(
    () =>
      subscribeChildProfileChanged((reason) => {
        if (reason !== 'saved') return;
        const bands = childrenToAgeBands(readProfile()?.children ?? []);
        if (bands.length === 0) return;
        const current = stateRef.current;
        if (sameBands(current.ages, bands)) return; // already showing exactly this
        setApplied(true);
        router.replace(hrefFor(current, ageSelectionPatch(bands)));
      }),
    [router]
  );

  // The note stops being true the moment the parent edits the chips away from the profile's own
  // bands, so it is gated on the selection still MATCHING rather than on "we applied it once".
  const bands = profile ? childrenToAgeBands(profile.children) : [];
  if (!applied || bands.length === 0 || !sameBands(state.ages, bands)) return null;

  const description = describeChildAges(profile?.children ?? []);
  if (!description) return null;

  return (
    <p className="kf-profnote" role="status">
      <b className="kf-profnote__lede">That age filter is yours.</b> We started from the ages you saved on this
      device — {description}. Remove it above to see every age, or change it in the header.
    </p>
  );
}
